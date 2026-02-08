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

      // 保存配置并更新关联的机器人
      if (path === "/api/config/save" && request.method === "POST") {
        const { id, name, rules, botHashes } = await request.json();
        let configId = id;
        
        if (id) {
          await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(name, rules, id).run();
        } else {
          const res = await env.DB.prepare("INSERT INTO configs (name, rules) VALUES (?, ?)").bind(name, rules).run();
          configId = res.meta.last_row_id;
        }

        // 更新多对多关联：先删后加
        await env.DB.prepare("DELETE FROM bot_config_refs WHERE config_id = ?").bind(configId).run();
        if (botHashes && botHashes.length > 0) {
          const statements = botHashes.map(hash => 
            env.DB.prepare("INSERT INTO bot_config_refs (bot_hash, config_id) VALUES (?, ?)").bind(hash, configId)
          );
          await env.DB.batch(statements);
        }
        return new Response(JSON.stringify({ success: true }));
      }

      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare(`
          INSERT INTO bots (token_hash, token, name) VALUES (?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, token=excluded.token
        `).bind(tokenHash, bot.token, bot.name).run();
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
    }

    if (!isAuthed && (path === "/admin" || path === "/")) return Response.redirect(`${url.origin}/login`, 302);
    if (path === "/admin" || path === "/") return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // Webhook：支持叠加多个配置的规则
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const data = await env.DB.prepare(`
        SELECT c.rules FROM configs c
        JOIN bot_config_refs r ON c.id = r.config_id
        WHERE r.bot_hash = ?
      `).bind(tokenHash).all();

      const botInfo = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(tokenHash).first();
      if (!botInfo || data.results.length === 0) return new Response("OK");

      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return new Response("OK");

      const pureCommand = msg.text.split(' ')[0].split('@')[0];
      
      // 合并所有关联配置的规则 (后加入的配置规则会覆盖前面的)
      let combinedRules = {};
      data.results.forEach(row => {
        try { Object.assign(combinedRules, JSON.parse(row.rules)); } catch(e) {}
      });

      const reply = combinedRules[pureCommand];
      if (reply) await handleBotReply(msg, botInfo.token, reply);
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }
};

// ... (handleBotReply 和 sha256 函数保持不变) ...
async function handleBotReply(msg, token, replyTemplate) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  const urls = replyTemplate.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = replyTemplate.replace(/(https?:\/\/[^\s]+)/g, '').trim();
  let method = "sendMessage", payload = { chat_id: msg.chat.id };
  if (firstUrl) {
    const isPhoto = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(firstUrl);
    const isDoc = /\.(pdf|zip|rar|7z|doc|docx|mp4|apk)(\?.*)?$/i.test(firstUrl);
    if (isPhoto) { method="sendPhoto"; payload.photo=firstUrl; payload.caption=caption; }
    else if (isDoc) { method="sendDocument"; payload.document=firstUrl; payload.caption=caption; }
    else { payload.text = replyTemplate; }
  } else { payload.text = replyTemplate; }
  await fetch(`${botUrl}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>Bot Master</title></head>
  <body class="bg-[#f8fafc]">
    <div id="app" class="max-w-2xl mx-auto p-4 py-8">
      <div class="flex gap-2 mb-8 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则配置</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div class="flex justify-between items-center px-2">
          <h2 class="text-xl font-black">Bots</h2>
          <button @click="openBotModal()" class="bg-black text-white px-4 py-2 rounded-xl text-sm">+ 添加</button>
        </div>
        <div v-for="bot in bots" class="bg-white p-6 rounded-[2rem] border shadow-sm flex justify-between items-center">
          <div><p class="font-bold">{{bot.name}}</p></div>
          <button @click="editBot(bot)" class="text-blue-600 font-bold bg-blue-50 px-4 py-2 rounded-xl text-sm">编辑</button>
        </div>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div class="flex justify-between items-center px-2">
          <h2 class="text-xl font-black">Configs</h2>
          <button @click="openConfigModal()" class="bg-black text-white px-4 py-2 rounded-xl text-sm">+ 新建规则集</button>
        </div>
        <div v-for="cfg in configs" class="bg-white p-6 rounded-[2rem] border shadow-sm flex justify-between items-center">
          <p class="font-bold">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="text-blue-600 font-bold bg-blue-50 px-4 py-2 rounded-xl text-sm">配置机器人 & 规则</button>
        </div>
      </div>

      <div v-if="showConfigModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showConfigModal=false"></div>
        <div class="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl flex flex-col max-h-[90vh]">
          <h3 class="text-xl font-black mb-6">编辑规则集</h3>
          
          <div class="overflow-y-auto space-y-6">
            <section>
              <label class="text-xs font-bold text-slate-400 ml-2">配置名称</label>
              <input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold outline-none border border-slate-100">
            </section>

            <section>
              <label class="text-xs font-bold text-slate-400 ml-2">应用到以下机器人 (可多选)</label>
              <div class="flex flex-wrap gap-2 mt-2">
                <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" 
                     :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white border-blue-600':'bg-white text-slate-500 border-slate-200'"
                     class="px-4 py-2 rounded-xl border font-bold text-xs cursor-pointer transition-all">
                  {{bot.name}}
                </div>
              </div>
            </section>

            <section>
              <label class="text-xs font-bold text-slate-400 ml-2">回复规则</label>
              <div class="space-y-2 mt-2">
                <div v-for="(rule, index) in rulesList" class="flex gap-2">
                  <input v-model="rule.key" placeholder="/cmd" class="w-1/4 bg-slate-50 p-3 rounded-xl border text-sm font-mono outline-none">
                  <input v-model="rule.val" placeholder="回复内容" class="flex-1 bg-slate-50 p-3 rounded-xl border text-sm outline-none">
                  <button @click="rulesList.splice(index,1)" class="text-red-400 px-2 font-bold">×</button>
                </div>
                <button @click="rulesList.push({key:'',val:''})" class="w-full py-3 border-2 border-dashed rounded-2xl text-slate-400 text-xs font-bold">+ 添加规则</button>
              </section>
          </div>

          <button @click="saveConfig" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl mt-6 shadow-lg active:scale-95 transition-all">保存规则集</button>
        </div>
      </div>

      <div v-if="showBotModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showBotModal=false"></div>
        <div class="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl">
          <h3 class="text-xl font-black mb-6">机器人信息</h3>
          <input v-model="botForm.name" placeholder="备注名" class="w-full bg-slate-50 p-4 rounded-2xl border mb-4 outline-none">
          <input v-model="botForm.token" placeholder="Bot Token" class="w-full bg-slate-50 p-4 rounded-2xl border mb-8 outline-none font-mono text-xs">
          <button @click="saveBot" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg shadow-blue-200">完成</button>
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
              id: cfg.id, 
              name: cfg.name, 
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
            const payload = { ...this.configForm, rules: JSON.stringify(rulesObj) };
            await fetch('/api/config/save', { method: 'POST', body: JSON.stringify(payload) });
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