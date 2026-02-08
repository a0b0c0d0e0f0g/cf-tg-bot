export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET;

    // API 路由逻辑
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

    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (!isAuthed && (path === "/admin" || path === "/")) return Response.redirect(`${url.origin}/login`, 302);
    if (path === "/admin" || path === "/") return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // Webhook 处理
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>Bot Master</title>
  <style>
    .full-modal { position: fixed; inset: 0; z-index: 50; background: white; display: flex; flex-direction: column; }
    @media (min-width: 640px) { .full-modal { inset: 10% 20%; border-radius: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); height: 80%; } }
    .custom-scrollbar::-webkit-scrollbar { width: 4px; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
  </style>
  </head>
  <body class="bg-slate-50 text-slate-900 font-sans">
    <div id="app" class="max-w-2xl mx-auto p-4 pb-24">
      <div class="flex gap-2 mb-8 bg-white p-1.5 rounded-2xl shadow-sm border sticky top-4 z-40">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则配置</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div v-for="bot in bots" class="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm flex justify-between items-center">
          <div class="overflow-hidden">
            <p class="font-bold text-lg truncate">{{bot.name}}</p>
            <p class="text-[10px] text-slate-400 font-mono truncate">{{bot.token_hash.slice(0,12)}}...</p>
          </div>
          <button @click="editBot(bot)" class="ml-4 bg-slate-50 text-blue-600 font-bold px-4 py-2 rounded-xl text-sm whitespace-nowrap">编辑</button>
        </div>
        <button @click="openBotModal()" class="w-full py-5 border-2 border-dashed border-slate-200 rounded-3xl text-slate-400 font-bold">+ 添加机器人</button>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div v-for="cfg in configs" class="bg-white p-5 rounded-3xl border border-slate-100 shadow-sm flex justify-between items-center">
          <p class="font-bold text-lg">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="text-blue-600 font-bold bg-blue-50 px-5 py-2 rounded-xl text-sm">修改规则</button>
        </div>
        <button @click="openConfigModal()" class="w-full py-5 border-2 border-dashed border-slate-200 rounded-3xl text-slate-400 font-bold">+ 新建规则集</button>
      </div>

      <div v-if="showConfigModal" class="full-modal animate-in slide-in-from-bottom duration-300">
        <div class="p-6 border-b flex justify-between items-center bg-white sticky top-0 z-10">
          <button @click="showConfigModal=false" class="text-slate-400 text-xl">✕</button>
          <h3 class="font-black text-xl">编辑规则集</h3>
          <div class="w-6"></div>
        </div>
        
        <div class="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">规则集名称</label>
            <input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold border-none outline-none mt-2 focus:ring-2 ring-blue-500">
          </section>

          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">关联到机器人</label>
            <div class="flex flex-wrap gap-2 mt-3">
              <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" 
                   :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white shadow-blue-200 shadow-lg':'bg-slate-100 text-slate-400'"
                   class="px-4 py-2 rounded-xl font-bold text-xs transition-all cursor-pointer">
                {{bot.name}}
              </div>
            </div>
          </section>

          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">指令与回复内容</label>
            <div class="space-y-4 mt-3">
              <div v-for="(rule, index) in rulesList" class="p-4 bg-slate-50 rounded-2xl border border-slate-100 relative">
                <button @click="rulesList.splice(index,1)" class="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full text-[10px]">✕</button>
                <input v-model="rule.key" placeholder="/指令" class="w-full bg-transparent p-0 pb-2 border-b border-slate-200 mb-3 font-mono font-bold outline-none">
                <textarea v-model="rule.val" rows="3" placeholder="回复内容..." class="w-full bg-transparent text-sm outline-none resize-none"></textarea>
              </div>
              <button @click="rulesList.push({key:'',val:''})" class="w-full py-4 border-2 border-dashed border-slate-200 rounded-2xl text-slate-400 text-xs font-bold">+ 添加规则</button>
            </div>
          </section>
        </div>

        <div class="p-6 bg-white border-t flex gap-3">
          <button v-if="configForm.id" @click="deleteConfig" class="flex-1 bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveConfig" class="flex-[2] bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl shadow-blue-100">保存并应用</button>
        </div>
      </div>

      <div v-if="showBotModal" class="full-modal animate-in slide-in-from-bottom duration-300">
        <div class="p-6 border-b flex justify-between items-center">
          <button @click="showBotModal=false" class="text-slate-400">取消</button>
          <h3 class="font-black text-xl">机器人设置</h3>
          <div class="w-10"></div>
        </div>
        <div class="p-6 space-y-6">
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">机器人备注名</label>
            <input v-model="botForm.name" class="w-full bg-slate-50 p-4 rounded-2xl border-none outline-none mt-2">
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">HTTP API Token</label>
            <textarea v-model="botForm.token" rows="3" class="w-full bg-slate-50 p-4 rounded-2xl border-none outline-none mt-2 font-mono text-xs"></textarea>
          </section>
        </div>
        <div class="mt-auto p-6 flex gap-3 border-t">
          <button v-if="botForm.token_hash" @click="deleteBot(botForm.token_hash)" class="flex-1 bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveBot" class="flex-[2] bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">保存机器人</button>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            tab: 'bots', bots: [], configs: [], refs: [],
            showBotModal: false, showConfigModal: false,
            botForm: { name: '', token: '', token_hash: null },
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
          openBotModal() { this.botForm = { name: '', token: '', token_hash: null }; this.showBotModal = true; },
          editBot(bot) { this.botForm = { ...bot }; this.showBotModal = true; },
          async deleteBot(hash) {
            if(!confirm('确定彻底删除该机器人及其关联吗？')) return;
            await fetch('/api/bot/delete', { method: 'POST', body: JSON.stringify({ token_hash: hash }) });
            this.showBotModal = false; this.load();
          },
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
          async deleteConfig() {
            if(!confirm('确定删除此规则集吗？')) return;
            await fetch('/api/config/delete', { method: 'POST', body: JSON.stringify({ id: this.configForm.id }) });
            this.showConfigModal = false; this.load();
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