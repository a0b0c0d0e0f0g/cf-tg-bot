export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookie = request.headers.get("Cookie") || "";
    const isAuthed = cookie.includes(`session=${env.SESSION_SECRET}`);

    // 1. 登录页面渲染
    if (path === "/login" && request.method === "GET") {
      return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 2. 登录接口 - 校验账号密码并设置 Cookie
    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
            "Content-Type": "application/json"
          }
        });
      }
      return new Response(JSON.stringify({ success: false, msg: "账号或密码错误" }), { status: 401 });
    }

    // --- 权限拦截层 ---
    if (!isAuthed) {
      if (path.startsWith("/api/") || path === "/admin") {
        return Response.redirect(`${url.origin}/login`, 302);
      }
    }

    // 3. 管理后台页面
    if (path === "/admin" && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 4. API: 获取/保存机器人逻辑 (保持与之前一致，但增加了鉴权)
    if (path === "/api/bots" && request.method === "GET") {
      const list = await env.TG_BOT_KV.list({ prefix: "BOT_" });
      const bots = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.TG_BOT_KV.get(k.name))));
      return new Response(JSON.stringify(bots), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/api/save" && request.method === "POST") {
      const config = await request.json();
      const tokenHash = await sha256(config.token);
      await env.TG_BOT_KV.put(`BOT_${tokenHash}`, JSON.stringify(config));
      // 自动设置 Webhook
      const webhookUrl = `https://${url.hostname}/webhook/${tokenHash}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=${webhookUrl}`);
      const tgData = await tgRes.json();
      return new Response(JSON.stringify({ success: tgData.ok, msg: tgData.description }));
    }

    // 5. Webhook 入口 (无需 Cookie 校验，因为是 Telegram 服务器调用的)
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

// 辅助函数：SHA256
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// 消息处理逻辑
async function handleBotUpdate(update, config) {
  if (update.message && update.message.text) {
    const text = update.message.text;
    const rules = config.rules || {};
    const reply = rules[text] || (text === "/start" ? "服务已激活" : null);
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

// --- 登录页面 HTML ---
function renderLoginHTML() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><title>登录</title></head>
  <body class="bg-gray-900 flex items-center justify-center h-screen">
    <div class="bg-white p-8 rounded shadow-xl w-80">
      <h2 class="text-2xl font-bold mb-4 text-center">系统登录</h2>
      <input id="u" type="text" placeholder="账号" class="w-full border p-2 mb-2 rounded">
      <input id="p" type="password" placeholder="密码" class="w-full border p-2 mb-4 rounded">
      <button onclick="login()" id="btn" class="w-full bg-blue-600 text-white py-2 rounded">进入控制台</button>
    </div>
    <script>
      async function login(){
        const btn = document.getElementById('btn');
        btn.disabled = true; btn.innerText = '验证中...';
        const res = await fetch('/api/login',{
          method:'POST',
          body: JSON.stringify({user:document.getElementById('u').value, pass:document.getElementById('p').value})
        });
        if(res.ok) location.href='/admin';
        else { alert('登录失败'); btn.disabled = false; btn.innerText = '进入控制台'; }
      }
    </script>
  </body></html>`;
}

// --- 管理后台 HTML (带防连点) ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>管理后台</title></head>
  <body class="bg-gray-100 p-6">
    <div id="app" class="max-w-4xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">cf-tg-bot 管理系统</h1>
        <button @click="openModal()" class="bg-green-500 text-white px-4 py-2 rounded">添加新机器人</button>
      </div>
      
      <div class="bg-white rounded shadow divide-y">
        <div v-for="bot in bots" class="p-4 flex justify-between items-center">
          <div><span class="font-bold text-lg">{{bot.name}}</span><br><code class="text-xs text-gray-400">{{bot.token.slice(0,12)}}...</code></div>
          <button @click="editBot(bot)" class="text-blue-500 font-medium">配置管理</button>
        </div>
      </div>

      <div v-if="showModal" class="fixed inset-0 bg-black/50 flex items-center justify-center">
        <div class="bg-white p-6 rounded-lg w-[450px]">
          <h3 class="text-xl font-bold mb-4">{{isEdit?'修改':'新增'}}机器人</h3>
          <input v-model="form.name" placeholder="名称" class="w-full border p-2 mb-2">
          <input v-model="form.token" placeholder="Bot Token" class="w-full border p-2 mb-2" :disabled="isEdit">
          <label class="block text-sm text-gray-500">自动回复规则 (JSON)</label>
          <textarea v-model="form.rules" class="w-full border p-2 h-32 font-mono text-sm"></textarea>
          
          <div class="mt-4 flex justify-end gap-2">
            <button @click="showModal=false" class="px-4 py-2 border rounded">取消</button>
            <button @click="save" :disabled="loading" class="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400">
              {{ loading ? '同步中(请稍后)...' : '保存并设置Webhook' }}
            </button>
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
            this.loading = true; // 防连点启动
            try {
              const res = await fetch('/api/save', { 
                method: 'POST', 
                body: JSON.stringify({...this.form, rules: JSON.parse(this.form.rules)}) 
              });
              const data = await res.json();
              if(data.success) { alert('操作成功！'); this.showModal=false; this.load(); }
              else { alert('失败: ' + data.msg); }
            } catch(e) { alert('JSON 格式错误或网络问题'); }
            finally { this.loading = false; } // 恢复按钮
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}