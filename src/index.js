export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookie = request.headers.get("Cookie") || "";
    // 校验 Session
    const isAuthed = cookie.includes(`session=${env.SESSION_SECRET}`);

    // 1. 登录路由
    if (path === "/login") {
      if (isAuthed) return Response.redirect(`${url.origin}/admin`, 302);
      return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 2. 登录接口
    if (path === "/api/login" && request.method === "POST") {
      try {
        const { user, pass } = await request.json();
        if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
          return new Response(JSON.stringify({ success: true }), {
            headers: {
              "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict; Secure`,
              "Content-Type": "application/json"
            }
          });
        }
        return new Response(JSON.stringify({ success: false, msg: "凭据错误" }), { status: 401 });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, msg: "数据格式错误" }), { status: 400 });
      }
    }

    // --- 权限拦截 ---
    if (!isAuthed && (path.startsWith("/api/") || path === "/admin" || path === "/")) {
      return Response.redirect(`${url.origin}/login`, 302);
    }

    // 3. 管理后台
    if ((path === "/admin" || path === "/") && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 4. API: 获取列表
    if (path === "/api/bots" && request.method === "GET") {
      const list = await env.TG_BOT_KV.list({ prefix: "BOT_" });
      const bots = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.TG_BOT_KV.get(k.name))));
      return new Response(JSON.stringify(bots), { headers: { "Content-Type": "application/json" } });
    }

    // 5. API: 保存并设置 Webhook
    if (path === "/api/save" && request.method === "POST") {
      const config = await request.json();
      if (!config.token) return new Response(JSON.stringify({ success: false, msg: "Token必填" }));
      
      const tokenHash = await sha256(config.token);
      await env.TG_BOT_KV.put(`BOT_${tokenHash}`, JSON.stringify(config));

      // 调用 TG API 设置 Webhook
      const webhookUrl = `https://${url.hostname}/webhook/${tokenHash}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=${webhookUrl}`);
      const tgData = await tgRes.json();

      return new Response(JSON.stringify({ success: tgData.ok, msg: tgData.description }));
    }

    // 6. 机器人消息入口
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("Error", { status: 404 });
      const update = await request.json();
      return await handleBotUpdate(update, JSON.parse(configRaw));
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- 工具函数 ---
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleBotUpdate(update, config) {
  if (update.message?.text) {
    const text = update.message.text;
    const reply = config.rules?.[text] || (text === "/start" ? "机器人已激活" : null);
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

// --- 移动端兼容 HTML 模板 ---
function getCommonHead(title) {
  return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  `;
}

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head>${getCommonHead('登录')}</head>
  <body class="bg-slate-50 flex items-center justify-center min-h-screen p-4">
    <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm">
      <h2 class="text-2xl font-bold mb-6 text-gray-800 text-center">Bot System</h2>
      <div class="space-y-4">
        <input id="u" type="text" placeholder="管理账号" class="w-full border-gray-200 border p-3 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none">
        <input id="p" type="password" placeholder="访问密码" class="w-full border-gray-200 border p-3 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none">
        <button onclick="login()" id="btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-all active:scale-95">进入管理后台</button>
      </div>
    </div>
    <script>
      async function login(){
        const btn = document.getElementById('btn');
        btn.disabled = true; btn.innerText = '正在验证...';
        try {
          const res = await fetch('/api/login', {
            method: 'POST',
            body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
          });
          if(res.ok) location.href='/admin';
          else alert('账号或密码错误');
        } finally {
          btn.disabled = false; btn.innerText = '进入管理后台';
        }
      }
    </script>
  </body></html>`;
}

function renderAdminHTML() {
  return `<!DOCTYPE html><html><head>${getCommonHead('管理后台')}</head>
  <body class="bg-gray-50 min-h-screen pb-20">
    <div id="app" class="max-w-md mx-auto p-4 sm:max-w-2xl">
      <header class="flex justify-between items-center py-6">
        <h1 class="text-xl font-extrabold text-gray-900 tracking-tight">机器人列表</h1>
        <button @click="openModal()" class="bg-black text-white px-4 py-2 rounded-lg text-sm font-medium active:scale-95 transition-transform">＋ 添加</button>
      </header>

      <div class="space-y-3">
        <div v-for="bot in bots" class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-center">
          <div class="overflow-hidden">
            <div class="font-bold text-gray-800 truncate">{{bot.name}}</div>
            <div class="text-xs text-gray-400 font-mono">{{bot.token.slice(0,15)}}...</div>
          </div>
          <button @click="editBot(bot)" class="ml-4 text-blue-600 text-sm font-semibold">配置</button>
        </div>
        <div v-if="bots.length === 0" class="text-center py-10 text-gray-400 text-sm">暂无机器人，点击右上角添加</div>
      </div>

      <div v-if="showModal" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" @click="showModal=false"></div>
        <div class="relative bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl p-6 shadow-2xl animate-in slide-in-from-bottom duration-300">
          <div class="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-6 sm:hidden"></div>
          <h3 class="text-lg font-bold mb-4">{{isEdit?'编辑配置':'添加机器人'}}</h3>
          
          <div class="space-y-4">
            <input v-model="form.name" placeholder="显示名称 (如: 客服机器人)" class="w-full border-gray-100 border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none">
            <input v-model="form.token" placeholder="Telegram Bot Token" class="w-full border-gray-100 border bg-gray-50 p-3 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none" :disabled="isEdit">
            
            <div>
              <label class="text-xs font-bold text-gray-400 mb-2 block uppercase tracking-wider">自动回复规则 (JSON格式)</label>
              <textarea v-model="form.rules" placeholder='{"你好": "欢迎！"}' class="w-full border-gray-100 border bg-gray-50 p-3 rounded-xl h-32 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none"></textarea>
            </div>

            <div class="flex flex-col gap-2 pt-2">
              <button @click="save" :disabled="loading" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl disabled:bg-gray-300 transition-all active:scale-95 shadow-lg shadow-blue-200">
                {{ loading ? '正在请求 Telegram...' : '保存并下发 Webhook' }}
              </button>
              <button @click="showModal=false" class="w-full py-3 text-gray-500 text-sm">取消</button>
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
            if(!this.form.name || !this.form.token) return alert('请完整填写');
            this.loading = true;
            try {
              const res = await fetch('/api/save', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({...this.form, rules: JSON.parse(this.form.rules)}) 
              });
              const data = await res.json();
              if(data.success) { this.showModal=false; this.load(); }
              else { alert('错误: ' + data.msg); }
            } catch(e) { alert('语法错误，请检查规则是否为有效的 JSON'); }
            finally { this.loading = false; }
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}