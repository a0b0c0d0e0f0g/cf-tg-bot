export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET;

    // --- 1. 登录与基础 API ---
    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`, "Content-Type": "application/json" }
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    if (isAuthed) {
      if (path === "/api/data" && request.method === "GET") {
        const bots = (await env.DB.prepare("SELECT * FROM bots").all()).results;
        const configs = (await env.DB.prepare("SELECT * FROM configs").all()).results;
        const refs = (await env.DB.prepare("SELECT * FROM bot_config_refs").all()).results;
        return new Response(JSON.stringify({ bots, configs, refs }));
      }

      if (path === "/api/config/save" && request.method === "POST") {
        const { id, name, rules, botHashes } = await request.json();
        let configId = id;
        if (id) await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(name, rules, id).run();
        else {
          const res = await env.DB.prepare("INSERT INTO configs (name, rules) VALUES (?, ?)").bind(name, rules).run();
          configId = res.meta.last_row_id;
        }
        await env.DB.prepare("DELETE FROM bot_config_refs WHERE config_id = ?").bind(configId).run();
        if (botHashes?.length > 0) {
          const stmts = botHashes.map(h => env.DB.prepare("INSERT INTO bot_config_refs (bot_hash, config_id) VALUES (?, ?)").bind(h, configId));
          await env.DB.batch(stmts);
        }
        return new Response(JSON.stringify({ success: true }));
      }

      if (path === "/api/config/delete" && request.method === "POST") {
        const { id } = await request.json();
        await env.DB.prepare("DELETE FROM configs WHERE id = ?").bind(id).run();
        return new Response(JSON.stringify({ success: true }));
      }

      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare("INSERT INTO bots (token_hash, token, name) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, token=excluded.token").bind(tokenHash, bot.token, bot.name).run();
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }

      if (path === "/api/bot/delete" && request.method === "POST") {
        const { token_hash } = await request.json();
        const bot = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(token_hash).first();
        if (bot) await fetch(`https://api.telegram.org/bot${bot.token}/deleteWebhook`);
        await env.DB.prepare("DELETE FROM bots WHERE token_hash = ?").bind(token_hash).run();
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // --- 2. Webhook 消息与按钮点击处理 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const bot = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(tokenHash).first();
      if (!bot) return new Response("OK");

      const update = await request.json();
      let incomingText = "";
      let msgContext = null;

      // 普通文字消息
      if (update.message?.text) {
        incomingText = update.message.text;
        msgContext = update.message;
      } 
      // 按钮点击回调
      else if (update.callback_query) {
        incomingText = update.callback_query.data;
        msgContext = update.callback_query.message;
        // 回应 Telegram 消除转圈
        await fetch(`https://api.telegram.org/bot${bot.token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: update.callback_query.id })
        });
      }

      if (incomingText) {
        const rawParts = incomingText.trim().split(/\s+/).filter(p => p.length > 0);
        if (rawParts.length > 0) {
          const cmd = rawParts[0].split('@')[0];
          const args = rawParts.slice(1);
          
          const data = await env.DB.prepare("SELECT c.rules FROM configs c JOIN bot_config_refs r ON c.id = r.config_id WHERE r.bot_hash = ?").bind(tokenHash).all();
          let rules = {};
          data.results.forEach(row => { try { Object.assign(rules, JSON.parse(row.rules)); } catch(e){} });

          let template = rules[cmd];
          if (template) {
            let finalReply = template;
            // 参数替换 {{1}} - {{9}}
            for (let i = 1; i <= 9; i++) {
              finalReply = finalReply.replace(new RegExp(`\\{\\{${i}\\}\\}`, 'g'), args[i-1] || "");
            }
            finalReply = finalReply.replace(/\{\{name\}\}/g, args[0] || "");
            await handleBotReply(msgContext, bot.token, finalReply.trim());
          }
        }
      }
      return new Response("OK");
    }

    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html" } });
    if (!isAuthed) return Response.redirect(`${url.origin}/login`, 302);
    return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html" } });
  }
};

// --- 3. 核心回复逻辑：按钮提取、类型判断、图片发送 ---
async function handleBotReply(msg, token, reply) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  
  // 提取按钮 [文字|目标]
  const btnRegex = /\[([^\]|]+)\|([^\]]+)\]/g;
  let inline_keyboard = [];
  let currentRow = [];
  let match;
  
  while ((match = btnRegex.exec(reply)) !== null) {
    const text = match[1].trim();
    const target = match[2].trim();
    const btn = target.startsWith('http') ? { text, url: target } : { text, callback_data: target };
    currentRow.push(btn);
    if (currentRow.length === 2) { inline_keyboard.push(currentRow); currentRow = []; }
  }
  if (currentRow.length > 0) inline_keyboard.push(currentRow);

  // 清理正文并提取 URL
  let cleanText = reply.replace(btnRegex, '').trim();
  const urls = cleanText.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = cleanText.replace(/(https?:\/\/[^\s]+)/g, '').trim();

  let method = "sendMessage", payload = { 
    chat_id: msg.chat.id, 
    parse_mode: "HTML",
    reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
  };

  if (firstUrl) {
    const isImg = /\.(jpg|jpeg|png|gif|webp)/i.test(firstUrl) || /(api|php|img|run|image|unsplash|random|pic)/i.test(firstUrl);
    if (isImg) {
      method = "sendPhoto";
      const sep = firstUrl.includes('?') ? '&' : '?';
      payload.photo = `${firstUrl}${sep}t=${Date.now()}`;
      if (caption) payload.caption = caption;
    } else {
      payload.text = cleanText;
    }
  } else {
    payload.text = cleanText || "（无文字内容）";
  }

  const res = await fetch(`${botUrl}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    await fetch(`${botUrl}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: cleanText + (firstUrl ? "\\n" + firstUrl : "") })
    });
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- 4. 后台界面渲染 ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>BotMaster v2.1</title>
  <style>[v-cloak] { display: none; } .full-drawer { position: fixed; inset: 0; z-index: 100; background: white; display: flex; flex-direction: column; }</style></head>
  <body class="bg-slate-50 text-slate-900">
    <div id="app" v-cloak class="max-w-2xl mx-auto p-4 pb-24">
      <div class="flex gap-2 mb-6 bg-white p-1.5 rounded-2xl shadow-sm border sticky top-4 z-40">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white shadow-lg':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white shadow-lg':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则库</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div v-for="bot in bots" class="bg-white p-5 rounded-[2rem] border flex justify-between items-center shadow-sm">
          <div><p class="font-bold text-lg text-slate-800">{{bot.name}}</p><p class="text-[10px] text-slate-400 uppercase font-mono">HASH: {{bot.token_hash.slice(0,10)}}</p></div>
          <button @click="editBot(bot)" class="bg-blue-50 text-blue-600 font-bold px-5 py-2 rounded-xl text-sm">设置</button>
        </div>
        <button @click="openBotModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 添加机器人</button>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div v-for="cfg in configs" class="bg-white p-6 rounded-[2rem] border flex justify-between items-center shadow-sm">
          <p class="font-bold text-lg text-slate-800">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="bg-slate-900 text-white font-bold px-5 py-2 rounded-xl text-sm">编辑规则</button>
        </div>
        <button @click="openConfigModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 新建规则集</button>
      </div>

      <div v-if="showConfigModal" class="full-drawer animate-in slide-in-from-bottom duration-300">
        <div class="p-6 border-b flex justify-between items-center bg-white sticky top-0 z-10">
          <button @click="showConfigModal=false" class="text-slate-400">取消</button>
          <h3 class="font-black text-xl text-center">编辑规则集</h3>
          <button @click="saveConfig" class="text-blue-600 font-bold">保存</button>
        </div>
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          <section><label class="text-[10px] font-black text-slate-400 uppercase ml-1">规则集名称</label><input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold mt-2 outline-none"></section>
          <section><label class="text-[10px] font-black text-slate-400 uppercase ml-1">绑定机器人</label>
            <div class="flex flex-wrap gap-2 mt-2">
              <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white shadow-md':'bg-white text-slate-400 border'" class="px-4 py-2 rounded-xl text-[10px] font-bold cursor-pointer transition-all">{{bot.name}}</div>
            </div>
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase ml-1">指令配置</label>
            <div class="space-y-4 mt-3">
              <div v-for="(rule, idx) in rulesList" :key="idx" class="p-6 bg-slate-50 rounded-[2rem] border border-slate-200 relative shadow-inner">
                <input v-model="rule.key" placeholder="/指令" class="w-full bg-transparent font-mono font-bold text-blue-600 border-b border-slate-200 pb-2 mb-4 outline-none">
                <label class="text-[10px] font-black text-slate-400 uppercase">回复文本</label>
                <textarea v-model="rule.val" rows="2" placeholder="支持 HTML" class="w-full bg-white p-3 rounded-xl text-sm mt-1 mb-3 outline-none"></textarea>
                <label class="text-[10px] font-black text-slate-400 uppercase">按钮 (链接或 /指令)</label>
                <input v-model="rule.btns" placeholder="[文字|链接] [文字|/指令]" class="w-full bg-white p-3 rounded-xl text-xs mt-1 outline-none font-mono">
                <button @click="rulesList.splice(idx,1)" class="absolute -top-2 -right-2 bg-white text-red-500 w-8 h-8 rounded-full shadow-md border flex items-center justify-center">✕</button>
              </div>
              <button @click="rulesList.push({key:'',val:'',btns:''})" class="w-full py-4 border-2 border-dashed border-slate-300 rounded-2xl text-slate-400 font-bold">+ 新增指令</button>
            </div>
          </section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="configForm.id" @click="deleteConfig" class="bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveConfig" :class="configForm.id?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">保存应用</button>
        </div>
      </div>

      <div v-if="showBotModal" class="full-drawer">
        <div class="p-6 border-b flex justify-between items-center bg-white"><button @click="showBotModal=false" class="text-slate-400">取消</button><h3 class="font-black text-xl">机器人设置</h3><div class="w-10"></div></div>
        <div class="p-6 space-y-6 flex-1 overflow-y-auto">
          <section><label class="text-[10px] font-black text-slate-400 uppercase">备注名</label><input v-model="botForm.name" class="w-full bg-slate-50 p-5 rounded-3xl mt-2 outline-none font-bold"></section>
          <section><label class="text-[10px] font-black text-slate-400 uppercase">Token</label><textarea v-model="botForm.token" rows="4" class="w-full bg-slate-50 p-5 rounded-3xl mt-2 font-mono text-xs outline-none"></textarea></section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="botForm.token_hash" @click="deleteBot(botForm.token_hash)" class="bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveBot" :class="botForm.token_hash?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl">保存</button>
        </div>
      </div>
    </div>
    <script>
      const { createApp } = Vue;
      createApp({
        data() { return { tab: 'bots', bots: [], configs: [], refs: [], showBotModal: false, showConfigModal: false, botForm: { name: '', token: '', token_hash: null }, configForm: { id: null, name: '', botHashes: [] }, rulesList: [] } },
        methods: {
          async load() { const r = await fetch('/api/data'); const d = await r.json(); this.bots = d.bots; this.configs = d.configs; this.refs = d.refs; },
          openBotModal() { this.botForm = { name: '', token: '', token_hash: null }; this.showBotModal = true; },
          editBot(bot) { this.botForm = { ...bot }; this.showBotModal = true; },
          async deleteBot(hash) { if(confirm('确定删除机器人？')) { await fetch('/api/bot/delete', { method: 'POST', body: JSON.stringify({ token_hash: hash }) }); this.showBotModal = false; this.load(); } },
          async saveBot() { await fetch('/api/bot/save', { method: 'POST', body: JSON.stringify(this.botForm) }); this.showBotModal = false; this.load(); },
          openConfigModal() { this.configForm = { id: null, name: '', botHashes: [] }; this.rulesList = [{ key: '/start', val: '', btns: '' }]; this.showConfigModal = true; },
          editConfig(cfg) {
            this.configForm = { id: cfg.id, name: cfg.name, botHashes: this.refs.filter(r => r.config_id === cfg.id).map(r => r.bot_hash) };
            const raw = JSON.parse(cfg.rules || '{}');
            this.rulesList = Object.entries(raw).map(([k,v]) => {
              const btnMatches = v.match(/\\[[^\\]|]+\\|[^\\]]+\\]/g);
              const btns = btnMatches ? btnMatches.join(' ') : "";
              let text = v; if(btnMatches) btnMatches.forEach(b => text = text.replace(b, ''));
              return { key: k, val: text.trim(), btns: btns.trim() };
            });
            this.showConfigModal = true;
          },
          async deleteConfig() { if(confirm('确定删除规则集？')) { await fetch('/api/config/delete', { method: 'POST', body: JSON.stringify({ id: this.configForm.id }) }); this.showConfigModal = false; this.load(); } },
          toggleBot(hash) { const idx = this.configForm.botHashes.indexOf(hash); if (idx > -1) this.configForm.botHashes.splice(idx, 1); else this.configForm.botHashes.push(hash); },
          async saveConfig() {
            const rulesObj = {};
            this.rulesList.forEach(r => { if(r.key.trim()) rulesObj[r.key.trim()] = r.val + (r.btns ? "\\n" + r.btns : ""); });
            await fetch('/api/config/save', { method: 'POST', body: JSON.stringify({ ...this.configForm, rules: JSON.stringify(rulesObj) }) });
            this.showConfigModal = false; this.load();
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 flex items-center justify-center min-h-screen p-6"><div class="bg-white p-10 rounded-[3rem] shadow-2xl w-full max-w-sm text-center"><h1 class="text-3xl font-black mb-8 tracking-tighter text-slate-800">BotMaster</h1><input id="u" type="text" placeholder="Account" class="w-full p-5 bg-slate-50 rounded-2xl mb-3 outline-none focus:ring-2 ring-blue-500"><input id="p" type="password" placeholder="Password" class="w-full p-5 bg-slate-50 rounded-2xl mb-8 outline-none focus:ring-2 ring-blue-500"><button onclick="login()" class="w-full bg-blue-600 text-white font-black py-5 rounded-2xl shadow-xl active:scale-95 transition-transform">Login</button></div><script>async function login(){const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});if(r.ok) location.href='/admin'; else alert('Error');}</script></body></html>`;
}