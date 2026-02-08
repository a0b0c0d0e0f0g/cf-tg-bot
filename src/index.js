export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // API: 登录
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

    // API: 管理后台数据
    if (isAuthed) {
      if (path === "/api/data" && request.method === "GET") {
        const bots = (await env.DB.prepare("SELECT * FROM bots").all()).results;
        const configs = (await env.DB.prepare("SELECT * FROM configs").all()).results;
        return new Response(JSON.stringify({ bots, configs }));
      }

      if (path === "/api/config/save" && request.method === "POST") {
        const item = await request.json();
        // 这里的 rules 已经是处理好的 JSON 字符串了
        if (item.id) {
          await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(item.name, item.rules, item.id).run();
        } else {
          await env.DB.prepare("INSERT INTO configs (name, rules) VALUES (?, ?)").bind(item.name, item.rules).run();
        }
        return new Response(JSON.stringify({ success: true }));
      }

      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare(`
          INSERT INTO bots (token_hash, token, name, config_id) VALUES (?, ?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, config_id=excluded.config_id, token=excluded.token
        `).bind(tokenHash, bot.token, bot.name, bot.config_id || null).run();
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
    }

    if (!isAuthed && (path === "/admin" || path === "/")) return Response.redirect(`${url.origin}/login`, 302);
    if (path === "/admin" || path === "/") return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });

    // Webhook 逻辑
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const botData = await env.DB.prepare(`
        SELECT b.token, c.rules FROM bots b 
        LEFT JOIN configs c ON b.config_id = c.id 
        WHERE b.token_hash = ?
      `).bind(tokenHash).first();

      if (!botData) return new Response("OK");
      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return new Response("OK");

      const pureCommand = msg.text.split(' ')[0].split('@')[0];
      const rules = JSON.parse(botData.rules || '{}');
      const reply = rules[pureCommand] || (pureCommand === "/start" ? "🤖 配置已生效" : null);

      if (reply) await handleBotReply(msg, botData.token, reply);
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }
};

// 工具函数 (handleBotReply, sha256 保持一致...)
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
  <body class="bg-[#f8fafc] text-slate-900">
    <div id="app" class="max-w-2xl mx-auto p-4 py-8">
      <div class="flex gap-2 mb-8 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white shadow-md':'text-slate-400 hover:bg-slate-50'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人管理</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white shadow-md':'text-slate-400 hover:bg-slate-50'" class="flex-1 py-3 rounded-xl font-bold transition-all">公共配置库</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-2xl font-black italic text-slate-800 tracking-tighter">BOTS</h2>
          <button @click="openBotModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-blue-200 hover:scale-105 transition-transform">添加机器人</button>
        </div>
        <div v-for="bot in bots" class="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm flex justify-between items-center">
          <div>
            <p class="font-bold text-lg text-slate-800">{{bot.name}}</p>
            <p class="text-[10px] text-slate-400 font-mono mt-1">Token: {{bot.token.slice(0,12)}}...</p>
          </div>
          <button @click="editBot(bot)" class="bg-slate-900 text-white px-4 py-2 rounded-xl font-bold text-sm">设置</button>
        </div>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-2xl font-black italic text-slate-800 tracking-tighter">CONFIGS</h2>
          <button @click="openConfigModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-blue-200 hover:scale-105 transition-transform">新建规则集</button>
        </div>
        <div v-for="cfg in configs" class="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm flex justify-between items-center">
          <p class="font-bold text-lg text-slate-800">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="text-blue-600 font-bold text-sm bg-blue-50 px-4 py-2 rounded-xl hover:bg-blue-100 transition-colors">编辑规则</button>
        </div>
      </div>

      <div v-if="showBotModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showBotModal=false"></div>
        <div class="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl">
          <h3 class="text-xl font-black mb-6">Bot 设置</h3>
          <div class="space-y-4">
            <input v-model="botForm.name" placeholder="机器人名称" class="w-full bg-slate-50 p-4 rounded-2xl border border-slate-100 outline-none focus:border-blue-500">
            <input v-model="botForm.token" placeholder="Bot Token" class="w-full bg-slate-50 p-4 rounded-2xl border border-slate-100 outline-none font-mono text-xs focus:border-blue-500">
            <div class="relative">
              <select v-model="botForm.config_id" class="w-full bg-slate-50 p-4 rounded-2xl border border-slate-100 outline-none appearance-none focus:border-blue-500 text-slate-600">
                <option :value="null">-- 不关联配置 --</option>
                <option v-for="c in configs" :value="c.id">{{c.name}}</option>
              </select>
            </div>
          </div>
          <button @click="saveBot" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl mt-8 shadow-lg shadow-blue-200 active:scale-95 transition-all">保存更改</button>
        </div>
      </div>

      <div v-if="showConfigModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showConfigModal=false"></div>
        <div class="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <h3 class="text-xl font-black mb-6">编辑规则集</h3>
          <input v-model="configForm.name" placeholder="配置名称" class="w-full bg-slate-50 p-4 rounded-2xl font-bold outline-none border border-slate-100 mb-6">
          
          <div class="flex-1 overflow-y-auto pr-2 space-y-3">
            <div v-for="(rule, index) in rulesList" :key="index" class="flex gap-2 group animate-in slide-in-from-right-2">
              <input v-model="rule.key" placeholder="/指令" class="w-1/3 bg-slate-50 p-3 rounded-xl border border-slate-100 text-sm font-mono outline-none focus:border-blue-500">
              <input v-model="rule.val" placeholder="回复文字或图片链接" class="flex-1 bg-slate-50 p-3 rounded-xl border border-slate-100 text-sm outline-none focus:border-blue-500">
              <button @click="removeRule(index)" class="text-slate-300 hover:text-red-500 font-bold px-2">×</button>
            </div>
          </div>

          <button @click="addRule" class="mt-4 border-2 border-dashed border-slate-200 text-slate-400 py-3 rounded-2xl font-bold text-sm hover:bg-slate-50 transition-colors">+ 添加新指令</button>
          <button @click="saveConfig" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl mt-6 shadow-lg shadow-blue-200 active:scale-95 transition-all">保存并应用</button>
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
            configForm: { id: null, name: '' },
            rulesList: [] // 找回的键值对列表
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
          openConfigModal() { 
            this.configForm = { id: null, name: '' }; 
            this.rulesList = [{ key: '/start', val: '你好！' }];
            this.showConfigModal = true; 
          },
          editConfig(cfg) {
            this.configForm = { id: cfg.id, name: cfg.name };
            const rawRules = typeof cfg.rules === 'string' ? JSON.parse(cfg.rules || '{}') : cfg.rules;
            this.rulesList = Object.entries(rawRules).map(([k, v]) => ({ key: k, val: v }));
            this.showConfigModal = true;
          },
          addRule() { this.rulesList.push({ key: '', val: '' }); },
          removeRule(i) { this.rulesList.splice(i, 1); },
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><title>Login</title></head><body class="bg-slate-900 flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-[2rem] shadow-2xl w-full max-w-sm text-center"><h1 class="text-2xl font-black mb-6">Bot Master</h1><input id="u" type="text" placeholder="User" class="w-full p-4 bg-slate-50 rounded-2xl mb-3 outline-none border focus:border-blue-500"><input id="p" type="password" placeholder="Pass" class="w-full p-4 bg-slate-50 rounded-2xl mb-6 outline-none border focus:border-blue-500"><button onclick="login()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg shadow-blue-200">登录系统</button></div><script>async function login(){const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});if(r.ok) location.href='/admin'; else alert('账号或密码错误');}</script></body></html>`;
}