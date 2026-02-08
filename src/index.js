export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // --- 认证路由 ---
    if (path === "/login") {
      if (isAuthed) return Response.redirect(`${url.origin}/admin`, 302);
      return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`, "Content-Type": "application/json" }
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    // --- API 逻辑 (管理机器人与配置) ---
    if (isAuthed) {
      // 获取数据
      if (path === "/api/data" && request.method === "GET") {
        const bots = (await env.DB.prepare("SELECT * FROM bots").all()).results;
        const configs = (await env.DB.prepare("SELECT * FROM configs").all()).results;
        return new Response(JSON.stringify({ 
          bots, 
          configs: configs.map(c => ({ ...c, rules: JSON.parse(c.rules || '{}') })) 
        }));
      }

      // 保存配置
      if (path === "/api/config/save" && request.method === "POST") {
        const item = await request.json();
        if (item.id) {
          await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(item.name, JSON.stringify(item.rules), item.id).run();
        } else {
          await env.DB.prepare("INSERT INTO configs (name, rules) VALUES (?, ?)").bind(item.name, JSON.stringify(item.rules)).run();
        }
        return new Response(JSON.stringify({ success: true }));
      }

      // 保存机器人
      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare(`
          INSERT INTO bots (token_hash, token, name, config_id) VALUES (?, ?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, config_id=excluded.config_id
        `).bind(tokenHash, bot.token, bot.name, bot.config_id).run();
        
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
    }

    if (!isAuthed && (path === "/admin" || path === "/" || path.startsWith("/api/"))) {
      return Response.redirect(`${url.origin}/login`, 302);
    }

    if ((path === "/admin" || path === "/") && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // --- Webhook 处理逻辑 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      // 联表查询：通过机器人找到它关联的配置
      const botData = await env.DB.prepare(`
        SELECT bots.token, configs.rules 
        FROM bots 
        LEFT JOIN configs ON bots.config_id = configs.id 
        WHERE bots.token_hash = ?
      `).bind(tokenHash).first();

      if (!botData || !botData.rules) return new Response("OK");

      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return new Response("OK");

      const pureCommand = msg.text.split(' ')[0].split('@')[0];
      const rules = JSON.parse(botData.rules);
      let replyTemplate = rules[pureCommand] || (pureCommand === "/start" ? "🤖 机器人已关联配置并就绪" : null);

      if (replyTemplate) {
        // ... 此处保持之前的“获取中、超时处理、图片/文档识别、错误回显”逻辑 ...
        // (为了精简篇幅，逻辑同上一版，使用 botData.token 进行 fetch 操作)
        await handleBotReply(msg, botData.token, replyTemplate);
      }
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }
};

// 封装回复逻辑 (包含错误处理与超时)
async function handleBotReply(msg, token, replyTemplate) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  const urls = replyTemplate.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = replyTemplate.replace(/(https?:\/\/[^\s]+)/g, '').trim();
  let tempMsgId = null;

  if (firstUrl) {
    const tRes = await fetch(`${botUrl}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: "⏳ 正在获取资源...", disable_notification: true })
    });
    tempMsgId = (await tRes.json()).result?.message_id;
  }

  try {
    let method = "sendMessage", payload = { chat_id: msg.chat.id };
    if (firstUrl) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const apiRes = await fetch(firstUrl, { redirect: 'follow', signal: controller.signal });
        if (apiRes.url) firstUrl = apiRes.url;
        clearTimeout(timeoutId);
      } catch (e) { throw new Error(e.name === 'AbortError' ? "timeout" : "网络超时"); }

      const isPhoto = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(firstUrl);
      const isDoc = /\.(pdf|zip|rar|7z|doc|docx|mp4|apk)(\?.*)?$/i.test(firstUrl);
      if (isPhoto) { method="sendPhoto"; payload.photo=firstUrl; payload.caption=caption; }
      else if (isDoc) { method="sendDocument"; payload.document=firstUrl; payload.caption=caption; }
      else { payload.text = replyTemplate; }
    } else { payload.text = replyTemplate; }

    const finalRes = await fetch(`${botUrl}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!finalRes.ok) throw new Error("发送失败");
    if (tempMsgId) await fetch(`${botUrl}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id, message_id: tempMsgId }) });
  } catch (err) {
    const errorText = `❌ 获取资源失败: ${err.message}`;
    if (tempMsgId) await fetch(`${botUrl}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id, message_id: tempMsgId, text: errorText }) });
    else await fetch(`${botUrl}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id, text: errorText }) });
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- UI 部分 (双菜单设计) ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><style>.modal-scroll{max-height:60vh;overflow-y:auto;}</style><title>Bot Manager</title></head>
  <body class="bg-slate-50 min-h-screen font-sans text-slate-900">
    <div id="app" class="max-w-2xl mx-auto p-6">
      <div class="flex gap-4 mb-8 bg-white p-2 rounded-2xl shadow-sm border">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white':'text-slate-500'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人管理</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white':'text-slate-500'" class="flex-1 py-3 rounded-xl font-bold transition-all">配置管理</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div class="flex justify-between items-center px-2">
          <h2 class="text-xl font-black">机器人列表</h2>
          <button @click="openBotModal()" class="bg-slate-900 text-white px-4 py-2 rounded-xl text-sm font-bold">添加机器人</button>
        </div>
        <div v-for="bot in bots" class="bg-white p-5 rounded-3xl shadow-sm border flex justify-between items-center">
          <div>
            <div class="font-bold text-lg">{{bot.name}}</div>
            <div class="text-xs text-blue-500 font-medium bg-blue-50 px-2 py-0.5 rounded mt-1 inline-block">关联配置 ID: {{bot.config_id || '未关联'}}</div>
          </div>
          <button @click="editBot(bot)" class="text-slate-400 font-bold hover:text-blue-600 transition-colors">编辑</button>
        </div>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div class="flex justify-between items-center px-2">
          <h2 class="text-xl font-black">公共配置集</h2>
          <button @click="openConfigModal()" class="bg-slate-900 text-white px-4 py-2 rounded-xl text-sm font-bold">创建新配置</button>
        </div>
        <div v-for="cfg in configs" class="bg-white p-5 rounded-3xl shadow-sm border flex justify-between items-center">
          <div>
            <div class="font-bold text-lg text-slate-700">#{{cfg.id}} - {{cfg.name}}</div>
            <div class="text-xs text-slate-400 mt-1">{{Object.keys(cfg.rules).length}} 条指令已设置</div>
          </div>
          <button @click="editConfig(cfg)" class="text-slate-400 font-bold hover:text-blue-600 transition-colors">编辑规则</button>
        </div>
      </div>

      <div v-if="showBotModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showBotModal=false"></div>
        <div class="relative bg-white w-full max-w-md rounded-[2.5rem] p-8 shadow-2xl">
          <h2 class="text-xl font-black mb-6">机器人设置</h2>
          <div class="space-y-4">
            <input v-model="botForm.name" placeholder="显示名称" class="w-full bg-slate-50 p-4 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500">
            <input v-model="botForm.token" placeholder="Bot Token" class="w-full bg-slate-50 p-4 rounded-2xl outline-none font-mono text-xs border-2 border-transparent focus:border-blue-500">
            <select v-model="botForm.config_id" class="w-full bg-slate-50 p-4 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500 appearance-none">
              <option :value="null">请选择要关联的配置</option>
              <option v-for="c in configs" :value="c.id">{{c.name}} (ID:{{c.id}})</option>
            </select>
          </div>
          <button @click="saveBot" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl mt-8 shadow-lg shadow-blue-100">保存并设置 Webhook</button>
        </div>
      </div>

      <div v-if="showConfigModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showConfigModal=false"></div>
        <div class="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl max-h-[90vh] flex flex-col">
          <h2 class="text-xl font-black mb-6">编辑配置规则</h2>
          <div class="modal-scroll space-y-4 pr-2">
            <input v-model="configForm.name" placeholder="配置名称 (如: 通用配置A)" class="w-full bg-slate-100 p-4 rounded-2xl font-bold outline-none border-2 border-transparent focus:border-blue-500 mb-4">
            <div v-for="(v, k, i) in configForm.rules" :key="i" class="bg-slate-50 p-4 rounded-2xl relative border border-slate-100">
              <input v-model="tempKeys[k]" @blur="renameKey(k)" placeholder="指令 (如 /start)" class="w-full bg-white p-2 rounded-lg text-sm mb-2 font-mono outline-none shadow-sm">
              <textarea v-model="configForm.rules[k]" placeholder="内容/链接" class="w-full bg-white p-2 rounded-lg text-sm h-20 outline-none shadow-sm"></textarea>
              <button @click="delete configForm.rules[k]" class="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full text-xs shadow-md">✕</button>
            </div>
            <button @click="addRuleRow" class="w-full py-4 border-2 border-dashed border-slate-200 text-slate-400 rounded-2xl text-xs font-bold hover:bg-slate-50 transition-all">+ 添加新指令</button>
          </div>
          <button @click="saveConfig" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl mt-8 flex-shrink-0">保存配置</button>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            tab: 'bots', bots: [], configs: [], showBotModal: false, showConfigModal: false,
            botForm: { name: '', token: '', config_id: null },
            configForm: { id: null, name: '', rules: {} },
            tempKeys: {} // 辅助修改 JSON 的 Key
          }
        },
        methods: {
          async load() {
            const r = await fetch('/api/data');
            const d = await r.json();
            this.bots = d.bots; this.configs = d.configs;
          },
          openBotModal() { this.botForm = { name: '', token: '', config_id: null }; this.showBotModal = true; },
          editBot(bot) { this.botForm = { ...bot }; this.showBotModal = true; },
          async saveBot() {
            await fetch('/api/bot/save', { method: 'POST', body: JSON.stringify(this.botForm) });
            this.showBotModal = false; this.load();
          },
          openConfigModal() { this.configForm = { id: null, name: '', rules: {} }; this.showConfigModal = true; },
          editConfig(cfg) { 
            this.configForm = JSON.parse(JSON.stringify(cfg));
            Object.keys(this.configForm.rules).forEach(k => this.tempKeys[k] = k);
            this.showConfigModal = true; 
          },
          addRuleRow() { const k = '/new_' + Date.now(); this.configForm.rules[k] = ''; this.tempKeys[k] = k; },
          renameKey(oldK) {
            const newK = this.tempKeys[oldK];
            if (newK !== oldK) {
              const val = this.configForm.rules[oldK];
              delete this.configForm.rules[oldK];
              this.configForm.rules[newK] = val;
              delete this.tempKeys[oldK]; this.tempKeys[newK] = newK;
            }
          },
          async saveConfig() {
            await fetch('/api/config/save', { method: 'POST', body: JSON.stringify(this.configForm) });
            this.showConfigModal = false; this.load();
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}



function renderLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><title>Login</title></head><body class="bg-slate-50 flex items-center justify-center min-h-screen p-6 font-sans"><div class="bg-white p-10 rounded-[2.5rem] shadow-xl w-full max-w-sm"><h1 class="text-3xl font-black mb-10 text-center text-slate-800">Login</h1><div class="space-y-4"><input id="u" type="text" placeholder="账号" class="w-full p-4 bg-slate-50 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500 transition-all text-center"><input id="p" type="password" placeholder="密码" class="w-full p-4 bg-slate-50 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500 transition-all text-center"><button onclick="login()" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all mt-4">进入管理后台</button></div></div><script>async function login(){const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value}) });if(res.ok) location.href='/admin'; else alert('凭据错误');}</script></body></html>`;
}