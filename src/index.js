/**
 * Telegram Bot 管理系统 - 修复版
 * 改进：分行显示规则、修复添加按钮、移除抽屉式布局
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    if (path === "/login") {
      if (isAuthed) return Response.redirect(`${url.origin}/admin`, 302);
      return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (path === "/api/login" && request.method === "POST") {
      try {
        const { user, pass } = await request.json();
        if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
          return new Response(JSON.stringify({ success: true }), {
            headers: {
              "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`,
              "Content-Type": "application/json"
            }
          });
        }
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      } catch (e) { return new Response("Error", { status: 400 }); }
    }

    if (!isAuthed && (path === "/admin" || path === "/" || path.startsWith("/api/"))) {
      return Response.redirect(`${url.origin}/login`, 302);
    }

    if ((path === "/admin" || path === "/") && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (path === "/api/bots" && request.method === "GET") {
      const list = await env.TG_BOT_KV.list({ prefix: "BOT_" });
      const bots = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.TG_BOT_KV.get(k.name))));
      return new Response(JSON.stringify(bots), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/api/save" && request.method === "POST") {
      const config = await request.json();
      const tokenHash = await sha256(config.token);
      await env.TG_BOT_KV.put(`BOT_${tokenHash}`, JSON.stringify(config));
      const tgRes = await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
      const tgData = await tgRes.json();
      return new Response(JSON.stringify({ success: tgData.ok, msg: tgData.description }));
    }

    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("Error", { status: 404 });
      const update = await request.json();
      const config = JSON.parse(configRaw);
      if (update.message?.text) {
        const reply = config.rules?.[update.message.text] || (update.message.text === "/start" ? "已激活" : null);
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
    return new Response("Not Found", { status: 404 });
  }
};

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const commonHead = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <style>
    input, textarea { font-size: 16px !important; }
    .modal-scroll { max-height: calc(100vh - 160px); overflow-y: auto; }
  </style>
`;

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Login</title></head>
  <body class="bg-gray-100 flex items-center justify-center min-h-screen p-6">
    <div class="bg-white p-8 rounded-3xl shadow-xl w-full max-w-sm">
      <h1 class="text-2xl font-black mb-6 text-center text-gray-800">Bot Admin</h1>
      <div class="space-y-4">
        <input id="u" type="text" placeholder="账号" class="w-full p-4 bg-gray-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500">
        <input id="p" type="password" placeholder="密码" class="w-full p-4 bg-gray-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500">
        <button onclick="login()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all">登录</button>
      </div>
    </div>
    <script>
      async function login(){
        const res = await fetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
        });
        if(res.ok) location.href='/admin'; else alert('登录失败');
      }
    </script>
  </body></html>`;
}

function renderAdminHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Admin</title></head>
  <body class="bg-slate-50 min-h-screen">
    <div id="app" class="max-w-xl mx-auto p-4 sm:p-8">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-xl font-bold text-slate-800">Bot Manager</h1>
        <button @click="openModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-blue-100">添加机器人</button>
      </div>

      <div class="grid gap-3">
        <div v-for="bot in bots" class="bg-white p-4 rounded-2xl shadow-sm flex justify-between items-center border border-slate-100">
          <div class="truncate">
            <div class="font-bold text-slate-700">{{bot.name}}</div>
            <div class="text-[10px] text-slate-400 font-mono mt-1">{{bot.token.slice(0,16)}}...</div>
          </div>
          <button @click="editBot(bot)" class="text-blue-600 font-bold text-xs px-3">配置</button>
        </div>
      </div>

      <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" @click="showModal=false"></div>
        <div class="relative bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col max-h-[90vh]">
          <div class="p-6 border-b border-slate-50 flex justify-between items-center">
            <h2 class="text-lg font-bold">{{isEdit ? '编辑' : '新增'}}机器人</h2>
            <button @click="showModal=false" class="text-slate-400 font-bold text-xl">×</button>
          </div>
          
          <div class="p-6 modal-scroll space-y-5">
            <div>
              <label class="text-[10px] font-bold text-slate-400 mb-1 block">基础信息</label>
              <input v-model="form.name" placeholder="机器人名称" class="w-full bg-slate-50 p-4 rounded-xl outline-none mb-3 border border-transparent focus:border-blue-500 transition-all">
              <input v-model="form.token" placeholder="Bot Token" :disabled="isEdit" class="w-full bg-slate-50 p-4 rounded-xl outline-none font-mono text-xs border border-transparent focus:border-blue-500 transition-all">
            </div>

            <div>
              <div class="flex justify-between items-center mb-3">
                <label class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">回复规则</label>
                <button @click="uiMode = uiMode === 'visual' ? 'json' : 'visual'" class="text-blue-600 text-[10px] font-bold px-2 py-1 bg-blue-50 rounded">
                  切换到 {{uiMode === 'visual' ? 'JSON' : '可视化'}}
                </button>
              </div>

              <div v-if="uiMode === 'visual'" class="space-y-4">
                <div v-for="(item, index) in rulesArray" :key="index" class="bg-slate-50 p-4 rounded-2xl relative border border-slate-100">
                  <div class="space-y-2">
                    <div class="text-[10px] text-slate-400 font-bold">当用户输入：</div>
                    <input v-model="item.key" @input="syncRules" placeholder="例如: /hello" class="w-full bg-white p-2.5 rounded-lg text-sm border-0 shadow-sm outline-none">
                    <div class="text-[10px] text-slate-400 font-bold mt-2 text-center">则回复：</div>
                    <textarea v-model="item.value" @input="syncRules" placeholder="例如: 你好！" class="w-full bg-white p-2.5 rounded-lg text-sm border-0 shadow-sm outline-none h-16"></textarea>
                  </div>
                  <button @click="removeRule(index)" class="absolute -top-2 -right-2 bg-red-100 text-red-500 w-6 h-6 rounded-full text-xs shadow-sm">✕</button>
                </div>
                <button @click="addRule" class="w-full py-3 border-2 border-dashed border-slate-200 text-slate-400 rounded-xl text-xs font-bold hover:bg-slate-50 transition-all">＋ 添加新回复规则</button>
              </div>

              <div v-else>
                <textarea v-model="form.rules" @input="syncArray" class="w-full bg-slate-900 text-green-400 p-4 rounded-xl font-mono text-[11px] h-48 outline-none"></textarea>
              </div>
            </div>
          </div>

          <div class="p-6 border-t border-slate-50">
            <button @click="save" :disabled="loading" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all shadow-lg disabled:bg-slate-200">
              {{ loading ? '⏳ 正在处理...' : '确认并同步到 Telegram' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            bots: [], showModal: false, loading: false, isEdit: false,
            uiMode: 'visual',
            form: { name: '', token: '', rules: '{}' },
            rulesArray: [] // 独立数组用于可视化编辑，防止 Vue 丢失追踪
          }
        },
        methods: {
          async load() { const r = await fetch('/api/bots'); this.bots = await r.json(); },
          openModal() {
            this.isEdit = false;
            this.form = { name: '', token: '', rules: '{"/start":"机器人已就绪"}' };
            this.syncArray();
            this.showModal = true;
          },
          editBot(bot) {
            this.isEdit = true;
            this.form = { ...bot, rules: JSON.stringify(bot.rules) };
            this.syncArray();
            this.showModal = true;
          },
          // 核心：将 JSON 字符串同步到可视化数组
          syncArray() {
            try {
              const obj = JSON.parse(this.form.rules);
              this.rulesArray = Object.keys(obj).map(k => ({ key: k, value: obj[k] }));
            } catch(e) { this.rulesArray = []; }
          },
          // 核心：将可视化数组同步回 JSON 字符串
          syncRules() {
            const obj = {};
            this.rulesArray.forEach(item => { if(item.key) obj[item.key] = item.value; });
            this.form.rules = JSON.stringify(obj, null, 2);
          },
          addRule() {
            // 使用 push 触发 Vue 响应式
            this.rulesArray.push({ key: '', value: '' });
          },
          removeRule(index) {
            this.rulesArray.splice(index, 1);
            this.syncRules();
          },
          async save() {
            this.loading = true;
            try {
              const res = await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...this.form, rules: JSON.parse(this.form.rules) })
              });
              const data = await res.json();
              if(data.success) { this.showModal = false; this.load(); }
              else { alert('失败: ' + data.msg); }
            } catch(e) { alert('JSON 语法有误'); }
            finally { this.loading = false; }
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}