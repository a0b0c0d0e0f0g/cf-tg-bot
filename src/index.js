/**
 * Telegram Bot 管理系统 - 完整版
 * 功能：多机器人管理、Webhook自动配置、移动端适配 UI、Cookie 鉴权
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 获取并解析 Cookie
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // 1. 登录页面渲染
    if (path === "/login") {
      if (isAuthed) return Response.redirect(`${url.origin}/admin`, 302);
      return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 2. 登录接口 (POST /api/login)
    if (path === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();
        const { user, pass } = body;

        // 严格校验环境变量
        if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
          const secret = env.SESSION_SECRET || "fallback_secret";
          return new Response(JSON.stringify({ success: true }), {
            headers: {
              // 适配移动端和不同域名的 Cookie 设置
              "Set-Cookie": `session=${secret}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`,
              "Content-Type": "application/json"
            }
          });
        }
        return new Response(JSON.stringify({ success: false, msg: "账号或密码错误" }), { status: 401 });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, msg: "非法请求" }), { status: 400 });
      }
    }

    // --- 鉴权拦截器 ---
    if (!isAuthed && (path === "/admin" || path === "/" || path.startsWith("/api/"))) {
      return Response.redirect(`${url.origin}/login`, 302);
    }

    // 3. 管理后台主页
    if ((path === "/admin" || path === "/") && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 4. API: 获取机器人列表
    if (path === "/api/bots" && request.method === "GET") {
      const list = await env.TG_BOT_KV.list({ prefix: "BOT_" });
      const bots = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.TG_BOT_KV.get(k.name))));
      return new Response(JSON.stringify(bots), { headers: { "Content-Type": "application/json" } });
    }

    // 5. API: 保存机器人配置并激活 Webhook
    if (path === "/api/save" && request.method === "POST") {
      const config = await request.json();
      if (!config.token) return new Response(JSON.stringify({ success: false, msg: "Missing Token" }));

      const tokenHash = await sha256(config.token);
      await env.TG_BOT_KV.put(`BOT_${tokenHash}`, JSON.stringify(config));

      // 注册 Webhook 到 Telegram
      const webhookUrl = `https://${url.hostname}/webhook/${tokenHash}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=${webhookUrl}`);
      const tgData = await tgRes.json();

      return new Response(JSON.stringify({ success: tgData.ok, msg: tgData.description }));
    }

    // 6. Webhook 消息处理入口
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("Bot Not Found", { status: 404 });
      
      const update = await request.json();
      return await handleBotUpdate(update, JSON.parse(configRaw));
    }

    return new Response("Not Found", { status: 404 });
  }
};

/** 辅助函数：计算哈希 */
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 核心逻辑：处理 Telegram 消息 */
async function handleBotUpdate(update, config) {
  if (update.message?.text) {
    const text = update.message.text;
    const reply = config.rules?.[text] || (text === "/start" ? "👋 机器人已就绪" : null);
    if (reply) {
      await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: update.message.chat.id, text: reply })
      });
    }
  }
  return new Response("OK");
}

/** 移动端优化公共头部 */
const commonHead = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <style>
    .glass { background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(10px); }
    .btn-active:active { transform: scale(0.96); }
  </style>
`;

/** 登录页面 */
function renderLoginHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Login</title></head>
  <body class="bg-slate-900 flex items-center justify-center min-h-screen p-4">
    <div class="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-3xl font-black text-slate-800">Admin</h1>
        <p class="text-slate-400 text-sm mt-2">请输入凭据进入管理控制台</p>
      </div>
      <div class="space-y-4">
        <input id="u" type="text" placeholder="Username" class="w-full bg-slate-50 border-0 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all">
        <input id="p" type="password" placeholder="Password" class="w-full bg-slate-50 border-0 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all">
        <button onclick="login()" id="btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-blue-200 btn-active transition-all">立即登录</button>
      </div>
    </div>
    <script>
      async function login(){
        const btn = document.getElementById('btn');
        btn.disabled = true; btn.innerText = '正在验证...';
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
        });
        if(res.ok) location.href='/admin';
        else { alert('登录失败，请检查账号密码'); btn.disabled = false; btn.innerText = '立即登录'; }
      }
    </script>
  </body></html>`;
}

/** 管理后台 */
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Admin Console</title></head>
  <body class="bg-slate-50 min-h-screen">
    <div id="app" class="max-w-xl mx-auto px-4 py-8">
      <div class="flex justify-between items-end mb-10">
        <div>
          <h1 class="text-2xl font-black text-slate-900">Bot Manager</h1>
          <p class="text-slate-500 text-xs mt-1">控制 Cloudflare Worker 上的机器人集群</p>
        </div>
        <button @click="openModal()" class="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold btn-active shadow-md">＋ 新增</button>
      </div>

      <div class="space-y-4">
        <div v-for="bot in bots" class="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex justify-between items-center">
          <div class="truncate mr-4">
            <h3 class="font-bold text-slate-800 truncate">{{bot.name}}</h3>
            <p class="text-[10px] font-mono text-slate-300 mt-1 truncate">{{bot.token}}</p>
          </div>
          <button @click="editBot(bot)" class="text-blue-600 font-bold text-sm shrink-0 px-2 py-1">配置</button>
        </div>
        <div v-if="bots.length === 0" class="text-center py-20 text-slate-300 text-sm italic">点击右上角按钮开始添加机器人</div>
      </div>

      <div v-if="showModal" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" @click="showModal=false"></div>
        <div class="relative bg-white w-full sm:max-w-md rounded-t-[2.5rem] sm:rounded-3xl p-8 shadow-2xl animate-in slide-in-from-bottom duration-300">
          <div class="w-12 h-1 bg-slate-200 rounded-full mx-auto mb-6 sm:hidden"></div>
          <h2 class="text-xl font-black mb-6 text-slate-800">{{isEdit?'更新机器人':'新增机器人'}}</h2>
          
          <div class="space-y-4">
            <div>
              <label class="text-[10px] font-bold text-slate-400 ml-1 mb-1 block">ROBOT NAME</label>
              <input v-model="form.name" placeholder="例如：我的第一号机器人" class="w-full bg-slate-50 border-0 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div v-if="!isEdit">
              <label class="text-[10px] font-bold text-slate-400 ml-1 mb-1 block">BOT TOKEN</label>
              <input v-model="form.token" placeholder="从 @BotFather 获取的 Token" class="w-full bg-slate-50 border-0 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs">
            </div>
            <div>
              <label class="text-[10px] font-bold text-slate-400 ml-1 mb-1 block">REPLY RULES (JSON)</label>
              <textarea v-model="form.rules" placeholder='{"/hi": "Hello!"}' class="w-full bg-slate-50 border-0 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs h-32"></textarea>
            </div>

            <div class="flex flex-col gap-3 pt-4">
              <button @click="save" :disabled="loading" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl btn-active disabled:bg-slate-200 transition-all">
                {{ loading ? '⏳ 正在同步 Telegram...' : '保存并激活' }}
              </button>
              <button @click="showModal=false" class="w-full text-slate-400 text-sm font-medium py-2">放弃更改</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() { return { bots: [], showModal: false, loading: false, isEdit: false, form: {name:'', token:'', rules:'{}'} } },
        methods: {
          async load() { const r = await fetch('/api/bots'); this.bots = await r.json(); },
          openModal() { this.isEdit=false; this.form={name:'', token:'', rules:'{}'}; this.showModal=true; },
          editBot(bot) { this.isEdit=true; this.form={...bot, rules: JSON.stringify(bot.rules, null, 2)}; this.showModal=true; },
          async save() {
            if(!this.form.name || !this.form.token) return alert('信息填写不全');
            this.loading = true; // 防连点逻辑
            try {
              const res = await fetch('/api/save', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({...this.form, rules: JSON.parse(this.form.rules)}) 
              });
              const data = await res.json();
              if(data.success) { this.showModal=false; this.load(); }
              else { alert('错误: ' + data.msg); }
            } catch(e) { alert('JSON 规则格式不正确'); }
            finally { this.loading = false; }
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}