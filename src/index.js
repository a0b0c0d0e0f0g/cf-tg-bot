export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET;

    // --- 认证与 API 逻辑 ---
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
        if (id) {
          await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(name, rules, id).run();
        } else {
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

    // --- 页面路由 ---
    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (!isAuthed && (path === "/admin" || path === "/")) return Response.redirect(`${url.origin}/login`, 302);
    if (path === "/admin" || path === "/") return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // --- Webhook 动态解析逻辑 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const botInfo = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(tokenHash).first();
      const data = await env.DB.prepare("SELECT c.rules FROM configs c JOIN bot_config_refs r ON c.id = r.config_id WHERE r.bot_hash = ?").bind(tokenHash).all();
      
      if (!botInfo || !data.results.length) return new Response("OK");

      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return new Response("OK");

      // 参数解析: /img 100 200 cat -> parts=["/img", "100", "200", "cat"]
      const parts = msg.text.trim().split(/\s+/);
      const cmd = parts[0].split('@')[0]; 
      const args = parts.slice(1);

      let rules = {};
      data.results.forEach(row => { try { Object.assign(rules, JSON.parse(row.rules)); } catch(e){} });

      let template = rules[cmd];
      if (template) {
        let finalReply = template;
        // 替换 {{1}} 到 {{9}}
        for (let i = 1; i <= 9; i++) {
          const placeholder = new RegExp(`\\{\\{${i}\\}\\}`, 'g');
          const value = args[i - 1] || ""; // 如果用户没传，替换为空字符串
          finalReply = finalReply.replace(placeholder, value);
        }
        // 兼容 {{name}} 占位符
        finalReply = finalReply.replace(/\{\{name\}\}/g, args[0] || "");
        
        await handleBotReply(msg, botInfo.token, finalReply.trim());
      }
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }
};

// --- 发送逻辑：支持图片探测、HTML、降级处理 ---
async function handleBotReply(msg, token, reply) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  const urls = reply.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = reply.replace(/(https?:\/\/[^\s]+)/g, '').trim();
  
  let method = "sendMessage", payload = { 
    chat_id: msg.chat.id, 
    parse_mode: "HTML" 
  };

  if (firstUrl) {
    const isImage = /\.(jpg|jpeg|png|gif|webp)/i.test(firstUrl) || 
                    /(api|php|img|run|image|source|unsplash|random|pic)/i.test(firstUrl);
    if (isImage) {
      method = "sendPhoto";
      payload.photo = firstUrl;
      payload.caption = caption;
    } else {
      payload.text = reply;
    }
  } else {
    payload.text = reply;
  }

  const res = await fetch(`${botUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  // 如果发送失败（可能是 HTML 语法错误或 API 暂时无法访问图片），降级为纯文本
  if (!res.ok) {
    delete payload.parse_mode;
    if (method === "sendPhoto") {
      method = "sendMessage";
      payload.text = reply;
      delete payload.photo; delete payload.caption;
    }
    await fetch(`${botUrl}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- 后台界面逻辑 ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>Bot Master</title>
  <style>
    [v-cloak] { display: none; }
    .full-drawer { position: fixed; inset: 0; z-index: 100; background: white; display: flex; flex-direction: column; overflow: hidden; }
    @media (min-width: 640px) { .full-drawer { inset: 5% 15%; border-radius: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); border: 1px solid #eee; height: 90%; } }
    .custom-scrollbar::-webkit-scrollbar { width: 4px; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
  </style></head>
  <body class="bg-slate-50 text-slate-900">
    <div id="app" v-cloak class="max-w-2xl mx-auto p-4 pb-24">
      <div class="flex gap-2 mb-6 bg-white p-1.5 rounded-2xl shadow-sm border sticky top-4 z-40">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white shadow-lg shadow-blue-200':'text-slate-400 hover:bg-slate-50'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white shadow-lg shadow-blue-200':'text-slate-400 hover:bg-slate-50'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则库</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4 animate-in fade-in">
        <div v-for="bot in bots" :key="bot.token_hash" class="bg-white p-5 rounded-[2rem] border border-slate-100 shadow-sm flex justify-between items-center">
          <div class="overflow-hidden">
            <p class="font-bold text-lg text-slate-800">{{bot.name}}</p>
            <p class="text-[10px] text-slate-400 font-mono mt-1 uppercase">ID: {{bot.token_hash.slice(0,10)}}</p>
          </div>
          <button @click="editBot(bot)" class="bg-blue-50 text-blue-600 font-bold px-5 py-2 rounded-xl text-sm active:scale-95 transition-transform">配置</button>
        </div>
        <button @click="openBotModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 添加新机器人</button>
      </div>

      <div v-if="tab==='configs'" class="space-y-4 animate-in fade-in">
        <div v-for="cfg in configs" :key="cfg.id" class="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm flex justify-between items-center">
          <p class="font-bold text-lg text-slate-800">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="bg-slate-900 text-white font-bold px-5 py-2 rounded-xl text-sm active:scale-95 transition-transform">修改规则</button>
        </div>
        <button @click="openConfigModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 新建规则集</button>
      </div>

      <div v-if="showConfigModal" class="full-drawer animate-in slide-in-from-bottom duration-300">
        <div class="p-6 border-b flex justify-between items-center bg-white sticky top-0 z-10 shadow-sm">
          <button @click="showConfigModal=false" class="text-slate-400 p-2">取消</button>
          <h3 class="font-black text-xl tracking-tighter">编辑规则集</h3>
          <button @click="saveConfig" class="text-blue-600 font-bold p-2">保存</button>
        </div>
        <div class="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">配置名称</label>
            <input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold border-none outline-none mt-2 focus:ring-2 ring-blue-500">
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">应用到机器人</label>
            <div class="flex flex-wrap gap-2 mt-3">
              <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" 
                   :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white shadow-lg border-blue-600':'bg-white text-slate-400 border-slate-200'"
                   class="px-4 py-2 rounded-xl border-2 font-black text-[10px] transition-all cursor-pointer">
                {{bot.name}}
              </div>
            </div>
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">回复指令集 (支持 {{1}}, {{2}}... 占位符)</label>
            <div class="space-y-4 mt-3">
              <div v-for="(rule, index) in rulesList" :key="index" class="p-5 bg-slate-50 rounded-3xl border border-slate-100 relative shadow-inner">
                <button @click="rulesList.splice(index,1)" class="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full text-[10px] flex items-center justify-center shadow-lg">✕</button>
                <input v-model="rule.key" placeholder="/指令" class="w-full bg-transparent p-0 pb-3 border-b border-slate-200 mb-4 font-mono font-bold text-blue-600 outline-none">
                <textarea v-model="rule.val" rows="4" placeholder="支持HTML标签, 如 <b>加粗</b>" class="w-full bg-transparent text-sm outline-none resize-none leading-relaxed"></textarea>
              </div>
              <button @click="rulesList.push({key:'',val:''})" class="w-full py-5 border-2 border-dashed border-slate-200 rounded-3xl text-slate-400 text-xs font-bold">+ 添加一条回复</button>
            </div>
          </section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="configForm.id" @click="deleteConfig" class="col-span-1 bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveConfig" :class="configForm.id?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl active:scale-95 transition-transform">保存更改</button>
        </div>
      </div>

      <div v-if="showBotModal" class="full-drawer animate-in slide-in-from-bottom duration-300">
        <div class="p-6 border-b flex justify-between items-center bg-white shadow-sm">
          <button @click="showBotModal=false" class="text-slate-400">取消</button>
          <h3 class="font-black text-xl tracking-tighter">BOT 设置</h3>
          <div class="w-10"></div>
        </div>
        <div class="p-6 space-y-8 flex-1 overflow-y-auto">
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">机器人备注名</label>
            <input v-model="botForm.name" class="w-full bg-slate-50 p-5 rounded-3xl border-none outline-none mt-2 focus:ring-2 ring-blue-500 font-bold">
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">TELEGRAM BOT TOKEN</label>
            <textarea v-model="botForm.token" rows="4" class="w-full bg-slate-50 p-5 rounded-3xl border-none outline-none mt-2 font-mono text-xs leading-loose"></textarea>
          </section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="botForm.token_hash" @click="deleteBot(botForm.token_hash)" class="col-span-1 bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveBot" :class="botForm.token_hash?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">保存机器人</button>
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
          async deleteBot(hash) { if(confirm('彻底删除该机器人？')) { await fetch('/api/bot/delete', { method: 'POST', body: JSON.stringify({ token_hash: hash }) }); this.showBotModal = false; this.load(); } },
          async saveBot() { await fetch('/api/bot/save', { method: 'POST', body: JSON.stringify(this.botForm) }); this.showBotModal = false; this.load(); },
          openConfigModal() { this.configForm = { id: null, name: '', botHashes: [] }; this.rulesList = [{ key: '/start', val: '' }]; this.showConfigModal = true; },
          editConfig(cfg) {
            this.configForm = { id: cfg.id, name: cfg.name, botHashes: this.refs.filter(r => r.config_id === cfg.id).map(r => r.bot_hash) };
            const raw = JSON.parse(cfg.rules || '{}');
            this.rulesList = Object.entries(raw).map(([k,v]) => ({key:k, val:v}));
            this.showConfigModal = true;
          },
          async deleteConfig() { if(confirm('删除此规则集？')) { await fetch('/api/config/delete', { method: 'POST', body: JSON.stringify({ id: this.configForm.id }) }); this.showConfigModal = false; this.load(); } },
          toggleBot(hash) { const idx = this.configForm.botHashes.indexOf(hash); if (idx > -1) this.configForm.botHashes.splice(idx, 1); else this.configForm.botHashes.push(hash); },
          async saveConfig() {
            const rulesObj = {};
            this.rulesList.forEach(r => { if(r.key.trim()) rulesObj[r.key.trim()] = r.val; });
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 flex items-center justify-center min-h-screen p-6"><div class="bg-white p-10 rounded-[3rem] shadow-2xl w-full max-w-sm text-center"><h1 class="text-3xl font-black mb-8 tracking-tighter">BotMaster</h1><input id="u" type="text" placeholder="Account" class="w-full p-5 bg-slate-50 rounded-2xl mb-3 outline-none border-none focus:ring-2 ring-blue-500"><input id="p" type="password" placeholder="Password" class="w-full p-5 bg-slate-50 rounded-2xl mb-8 outline-none border-none focus:ring-2 ring-blue-500"><button onclick="login()" class="w-full bg-blue-600 text-white font-black py-5 rounded-2xl shadow-xl shadow-blue-200 active:scale-95 transition-transform">Login</button></div><script>async function login(){const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});if(r.ok) location.href='/admin'; else alert('Error');}</script></body></html>`;
}