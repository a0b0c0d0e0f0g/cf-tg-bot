export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- 1. 简单的身份校验 (确保你在 wrangler.toml 或 Dashboard 设置了这些变量) ---
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // --- 2. 登录逻辑 ---
    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`,
            "Content-Type": "application/json"
          }
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // --- 3. 管理后台 API (需要登录) ---
    if (isAuthed) {
      // 获取所有机器人和配置
      if (path === "/api/data" && request.method === "GET") {
        const bots = (await env.DB.prepare("SELECT * FROM bots").all()).results;
        const configs = (await env.DB.prepare("SELECT * FROM configs").all()).results;
        return new Response(JSON.stringify({ bots, configs }));
      }

      // 保存配置
      if (path === "/api/config/save" && request.method === "POST") {
        const item = await request.json();
        if (item.id) {
          await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(item.name, item.rules, item.id).run();
        } else {
          await env.DB.prepare("INSERT INTO configs (name, rules) VALUES (?, ?)").bind(item.name, item.rules).run();
        }
        return new Response(JSON.stringify({ success: true }));
      }

      // 保存机器人
      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare(`
          INSERT INTO bots (token_hash, token, name, config_id) VALUES (?, ?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, config_id=excluded.config_id, token=excluded.token
        `).bind(tokenHash, bot.token, bot.name, bot.config_id || null).run();
        
        // 设置 Telegram Webhook
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // 鉴权拦截
    if (!isAuthed && (path === "/admin" || path === "/")) return Response.redirect(`${url.origin}/login`, 302);
    if (path === "/admin" || path === "/") return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // --- 4. Webhook 核心逻辑 (多机器人通用) ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      
      // 联合查询机器人 Token 和关联的规则
      const botData = await env.DB.prepare(`
        SELECT b.token, c.rules FROM bots b 
        LEFT JOIN configs c ON b.config_id = c.id 
        WHERE b.token_hash = ?
      `).bind(tokenHash).first();

      if (!botData) return new Response("OK");

      const update = await request.json();
      const msg = update.message;
      if (!msg || !msg.text) return new Response("OK");

      const pureCommand = msg.text.split(' ')[0].split('@')[0];
      
      // 解析规则
      let rules = {};
      try { rules = JSON.parse(botData.rules || '{}'); } catch (e) {}

      // 匹配回复逻辑
      let reply = rules[pureCommand];
      if (!reply && pureCommand === "/start") reply = "🤖 机器人已激活！请在后台关联配置规则。";

      if (reply) {
        await handleBotReply(msg, botData.token, reply);
      }
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- 工具函数：回复消息 (支持图片/文件) ---
async function handleBotReply(msg, token, replyTemplate) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  const urls = replyTemplate.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = replyTemplate.replace(/(https?:\/\/[^\s]+)/g, '').trim();

  let method = "sendMessage";
  let payload = { chat_id: msg.chat.id };

  if (firstUrl) {
    const isPhoto = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(firstUrl);
    const isDoc = /\.(pdf|zip|rar|7z|doc|docx|mp4|apk)(\?.*)?$/i.test(firstUrl);
    if (isPhoto) {
      method = "sendPhoto"; payload.photo = firstUrl; payload.caption = caption;
    } else if (isDoc) {
      method = "sendDocument"; payload.document = firstUrl; payload.caption = caption;
    } else {
      payload.text = replyTemplate;
    }
  } else {
    payload.text = replyTemplate;
  }

  await fetch(`${botUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

// SHA-256 哈希
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- HTML 模板 (后台 UI) ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>Bot Manager</title></head>
  <body class="bg-slate-50 min-h-screen pb-20">
    <div id="app" class="max-w-2xl mx-auto p-4">
      <div class="flex gap-2 my-8 bg-white p-1 rounded-2xl shadow-sm border">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white':'text-slate-500'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人列表</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white':'text-slate-500'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则配置库</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div class="flex justify-between items-center px-2">
          <h2 class="text-xl font-black">我的机器人</h2>
          <button @click="openBotModal()" class="bg-black text-white px-4 py-2 rounded-lg text-sm font-bold">+ 添加</button>
        </div>
        <div v-for="bot in bots" class="bg-white p-5 rounded-2xl border shadow-sm flex justify-between items-center">
          <div>
            <div class="font-bold">{{bot.name}}</div>
            <div class="text-xs text-slate-400 font-mono">{{bot.token.slice(0,10)}}...</div>
          </div>
          <button @click="editBot(bot)" class="text-blue-600 font-bold bg-blue-50 px-4 py-2 rounded-xl text-sm">编辑</button>
        </div>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div class="flex justify-between items-center px-2">
          <h2 class="text-xl font-black">通用规则库</h2>
          <button @click="openConfigModal()" class="bg-black text-white px-4 py-2 rounded-lg text-sm font-bold">+ 新建规则</button>
        </div>
        <div v-for="cfg in configs" class="bg-white p-5 rounded-2xl border shadow-sm flex justify-between items-center">
          <div><div class="font-bold">{{cfg.name}}</div></div>
          <button @click="editConfig(cfg)" class="text-blue-600 font-bold bg-blue-50 px-4 py-2 rounded-xl text-sm">修改规则</button>
        </div>
      </div>

      <div v-if="showBotModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div class="bg-white w-full max-w-sm rounded-3xl p-6 shadow-xl">
          <h3 class="text-lg font-bold mb-4">配置机器人</h3>
          <div class="space-y-3">
            <input v-model="botForm.name" placeholder="机器人备注名" class="w-full bg-slate-100 p-3 rounded-xl outline-none">
            <input v-model="botForm.token" placeholder="Telegram Bot Token" class="w-full bg-slate-100 p-3 rounded-xl outline-none font-mono text-sm">
            <select v-model="botForm.config_id" class="w-full bg-slate-100 p-3 rounded-xl outline-none">
              <option :value="null">-- 选择关联规则 --</option>
              <option v-for="c in configs" :value="c.id">{{c.name}}</option>
            </select>
          </div>
          <div class="flex gap-2 mt-6">
            <button @click="showBotModal=false" class="flex-1 py-3 font-bold text-slate-400">取消</button>
            <button @click="saveBot" class="flex-1 bg-blue-600 text-white py-3 rounded-xl font-bold">确认</button>
          </div>
        </div>
      </div>

      <div v-if="showConfigModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div class="bg-white w-full max-w-md rounded-3xl p-6 shadow-xl">
          <h3 class="text-lg font-bold mb-4">规则编辑器</h3>
          <div class="space-y-3">
            <input v-model="configForm.name" placeholder="配置名称" class="w-full bg-slate-100 p-3 rounded-xl outline-none font-bold">
            <p class="text-[10px] font-bold text-slate-400">JSON 格式规则 (指令: 回复内容)</p>
            <textarea v-model="configForm.rules" class="w-full h-64 bg-slate-900 text-green-400 p-4 rounded-xl font-mono text-xs outline-none" placeholder='{"/start": "欢迎"}'></textarea>
          </div>
          <div class="flex gap-2 mt-6">
            <button @click="showConfigModal=false" class="flex-1 py-3 font-bold text-slate-400">取消</button>
            <button @click="saveConfig" class="flex-1 bg-blue-600 text-white py-3 rounded-xl font-bold">保存规则</button>
          </div>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            tab: 'bots', bots: [], configs: [],
            showBotModal: false, showConfigModal: false,
            botForm: { name: '', token: '', config_id: null },
            configForm: { id: null, name: '', rules: '{}' }
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
            if(!this.botForm.token) return alert('Token 不能为空');
            await fetch('/api/bot/save', { method: 'POST', body: JSON.stringify(this.botForm) });
            this.showBotModal = false; this.load();
          },
          openConfigModal() { this.configForm = { id: null, name: '', rules: '{\\n  "/start": "Hello!"\\n}' }; this.showConfigModal = true; },
          editConfig(cfg) { this.configForm = { ...cfg }; this.showConfigModal = true; },
          async saveConfig() {
            try { JSON.parse(this.configForm.rules); } catch(e) { return alert('JSON 格式不正确'); }
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><title>Login</title></head>
  <body class="bg-slate-900 flex items-center justify-center min-h-screen p-4">
    <div class="bg-white p-8 rounded-[2rem] shadow-2xl w-full max-w-sm">
      <h1 class="text-2xl font-black mb-6 text-center">Bot Master</h1>
      <input id="u" type="text" placeholder="账号" class="w-full p-4 bg-slate-100 rounded-2xl mb-3 outline-none">
      <input id="p" type="password" placeholder="密码" class="w-full p-4 bg-slate-100 rounded-2xl mb-6 outline-none">
      <button onclick="login()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg shadow-blue-200">登录系统</button>
    </div>
    <script>async function login(){
      const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});
      if(r.ok) location.href='/admin'; else alert('账号或密码错误');
    }</script>
  </body></html>`;
}