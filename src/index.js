export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET;

    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`, "Content-Type": "application/json" }
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

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

      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare("INSERT INTO bots (token_hash, token, name) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, token=excluded.token").bind(tokenHash, bot.token, bot.name).run();
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
    }

    if (!isAuthed && (path === "/admin" || path === "/")) return Response.redirect(`${url.origin}/login`, 302);
    if (path === "/admin" || path === "/") return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const data = await env.DB.prepare("SELECT c.rules FROM configs c JOIN bot_config_refs r ON c.id = r.config_id WHERE r.bot_hash = ?").bind(tokenHash).all();
      const botInfo = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(tokenHash).first();
      if (!botInfo || !data.results.length) return new Response("OK");

      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return new Response("OK");

      const pureCmd = msg.text.split(' ')[0].split('@')[0];
      let rules = {};
      data.results.forEach(row => { try { Object.assign(rules, JSON.parse(row.rules)); } catch(e){} });

      const reply = rules[pureCmd];
      if (reply) await handleBotReply(msg, botInfo.token, reply);
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }
};

async function handleBotReply(msg, token, reply) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  const urls = reply.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = reply.replace(/(https?:\/\/[^\s]+)/g, '').trim();
  
  let method = "sendMessage", payload = { chat_id: msg.chat.id };
  if (firstUrl) {
    const isPhoto = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(firstUrl);
    const isDoc = /\.(pdf|zip|rar|7z|doc|docx|mp4|apk)(\?.*)?$/i.test(firstUrl);
    if (isPhoto) { method="sendPhoto"; payload.photo=firstUrl; payload.caption=caption; }
    else if (isDoc) { method="sendDocument"; payload.document=firstUrl; payload.caption=caption; }
    else { payload.text = reply; }
  } else { payload.text = reply; }
  await fetch(`${botUrl}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>Bot Master</title></head>
  <body class="bg-slate-50 text-slate-900 font-sans">
    <div id="app" class="max-w-2xl mx-auto p-4 py-8">
      <div class="flex gap-2 mb-8 bg-white p-1.5 rounded-2xl shadow-sm border">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则配置</button>
      </div>

      <div v-if="tab==='bots'" class="animate-in fade-in duration-300">
        <div class="flex justify-between items-center mb-6 px-2">
          <h2 class="text-2xl font-black tracking-tight">BOTS</h2>
          <button @click="openBotModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-blue-100">+ 添加机器人</button>
        </div>
        <div class="grid gap-4">
          <div v-for="bot in bots" class="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm flex justify-between items-center hover:shadow-md transition-shadow">
            <div><p class="font-bold text-lg text-slate-800">{{bot.name}}</p><p class="text-[10px] text-slate-400 font-mono mt-1">{{bot.token.slice(0,15)}}***</p></div>
            <button @click="editBot(bot)" class="bg-slate-50 text-slate-600 font-bold px-4 py-2 rounded-xl text-sm hover:bg-slate-100">管理</button>
          </div>
        </div>
      </div>

      <div v-if="tab==='configs'" class="animate-in fade-in duration-300">
        <div class="flex justify-between items-center mb-6 px-2">
          <h2 class="text-2xl font-black tracking-tight">CONFIGS</h2>
          <button @click="openConfigModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-blue-100">+ 新建规则集</button>
        </div>
        <div class="grid gap-4">
          <div v-for="cfg in configs" class="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm flex justify-between items-center hover:shadow-md transition-shadow">
            <p class="font-bold text-lg text-slate-800">{{cfg.name}}</p>
            <button @click="editConfig(cfg)" class="text-blue-600 font-bold bg-blue-50 px-5 py-2 rounded-xl text-sm hover:bg-blue-100">编辑</button>
          </div>
        </div>
      </div>

      <div v-if="showConfigModal" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" @click="showConfigModal=false"></div>
        <div class="relative bg-white w-full max-w-xl rounded-[2.5rem] p-6 sm:p-8 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
          <h3 class="text-xl font-black mb-6 px-2">编辑规则集</h3>
          
          <div class="flex-1 overflow-y-auto space-y-6 px-2 custom-scrollbar">
            <section>
              <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">规则集名称</label>
              <input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold outline-none border border-transparent focus:border-blue-500 transition-all mt-1">
            </section>

            <section>
              <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">关联机器人</label>
              <div class="flex flex-wrap gap-2 mt-2">
                <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" 
                     :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-100':'bg-white text-slate-400 border-slate-200'"
                     class="px-4 py-2 rounded-xl border font-bold text-xs cursor-pointer transition-all active:scale-95">
                  {{bot.name}}
                </div>
              </div>
            </section>

            <section>
              <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">指令回复规则</label>
              <div class="space-y-4 mt-2">
                <div v-for="(rule, index) in rulesList" class="p-4 bg-slate-50 rounded-2xl border border-slate-100 relative group">
                  <button @click="rulesList.splice(index,1)" class="absolute -top-2 -right-2 bg-white text-red-400 w-6 h-6 rounded-full shadow-sm border flex items-center justify-center text-xs font-bold hover:bg-red-50">×</button>
                  <input v-model="rule.key" placeholder="/指令 (如 /start)" class="w-full bg-transparent p-0 pb-2 border-b border-slate-200 mb-3 font-mono text-sm font-bold outline-none focus:border-blue-500">
                  <textarea v-model="rule.val" rows="3" placeholder="回复内容（支持多行，支持图片链接）" class="w-full bg-transparent text-sm outline-none resize-none leading-relaxed"></textarea>
                </div>
                <button @click="rulesList.push({key:'',val:''})" class="w-full py-4 border-2 border-dashed border-slate-200 rounded-2xl text-slate-400 text-xs font-bold hover:bg-slate-50 hover:border-slate-300 transition-all">+ 添加新回复规则</button>
              </div>
            </section>
          </div>

          <div class="pt-6">
            <button @click="saveConfig" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl shadow-blue-100 hover:bg-blue-700 active:scale-[0.98] transition-all">保存规则配置</button>
          </div>
        </div>
      </div>

      <div v-if="showBotModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" @click="showBotModal=false"></div>
        <div class="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl">
          <h3 class="text-xl font-black mb-6">机器人信息</h3>
          <div class="space-y-4">
            <input v-model="botForm.name" placeholder="备注名" class="w-full bg-slate-50 p-4 rounded-2xl border border-transparent outline-none focus:border-blue-500 transition-all">
            <input v-model="botForm.token" placeholder="Telegram Bot Token" class="w-full bg-slate-50 p-4 rounded-2xl border border-transparent outline-none font-mono text-xs focus:border-blue-500 transition-all">
          </div>
          <button @click="saveBot" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl mt-8 shadow-lg shadow-blue-100 active:scale-95 transition-all">完成配置</button>
        </div>
      </div>
    </div>

    <style>.custom-scrollbar::-webkit-scrollbar{width:4px}.custom-scrollbar::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:10px}</style>
    
    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            tab: 'bots', bots: [], configs: [], refs: [],
            showBotModal: false, showConfigModal: false,
            botForm: { name: '', token: '' },
            configForm: { id: null, name: '', botHashes: [] },
            rulesList: []
          }
        },
        methods: {
          async load() {
            const r = await fetch('/api/data');
            const d = await r.json();
            this.bots = d.bots; this.configs = d.configs; this.refs = d.refs;
          },
          openBotModal() { this.botForm = { name: '', token: '' }; this.showBotModal = true; },
          editBot(bot) { this.botForm = { ...bot }; this.showBotModal = true; },
          async saveBot() {
            await fetch('/api/bot/save', { method: 'POST', body: JSON.stringify(this.botForm) });
            this.showBotModal = false; this.load();
          },
          openConfigModal() {
            this.configForm = { id: null, name: '', botHashes: [] };
            this.rulesList = [{ key: '/start', val: '' }];
            this.showConfigModal = true;
          },
          editConfig(cfg) {
            this.configForm = { 
              id: cfg.id, name: cfg.name, 
              botHashes: this.refs.filter(r => r.config_id === cfg.id).map(r => r.bot_hash)
            };
            const raw = JSON.parse(cfg.rules || '{}');
            this.rulesList = Object.entries(raw).map(([k,v]) => ({key:k, val:v}));
            this.showConfigModal = true;
          },
          toggleBot(hash) {
            const idx = this.configForm.botHashes.indexOf(hash);
            if (idx > -1) this.configForm.botHashes.splice(idx, 1);
            else this.configForm.botHashes.push(hash);
          },
          async saveConfig() {
            const rulesObj = {};
            this.rulesList.forEach(r => { if(r.key) rulesObj[r.key] = r.val; });
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-[2rem] shadow-2xl w-full max-w-sm text-center"><h1 class="text-2xl font-black mb-6">Bot Master</h1><input id="u" type="text" placeholder="User" class="w-full p-4 bg-slate-50 rounded-2xl mb-3 border outline-none"><input id="p" type="password" placeholder="Pass" class="w-full p-4 bg-slate-50 rounded-2xl mb-6 border outline-none"><button onclick="login()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg">Login</button></div><script>async function login(){const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});if(r.ok) location.href='/admin'; else alert('Error');}</script></body></html>`;
}