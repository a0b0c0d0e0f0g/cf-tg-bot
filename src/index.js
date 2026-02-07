/**
 * Telegram Bot 管理系统 - 响应式可视化增强版
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

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
              "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`,
              "Content-Type": "application/json"
            }
          });
        }
        return new Response(JSON.stringify({ success: false, msg: "Unauthorized" }), { status: 401 });
      } catch (e) {
        return new Response(JSON.stringify({ success: false }), { status: 400 });
      }
    }

    // 权限校验
    if (!isAuthed && (path === "/admin" || path === "/" || path.startsWith("/api/"))) {
      return Response.redirect(`${url.origin}/login`, 302);
    }

    // 3. 管理后台
    if ((path === "/admin" || path === "/") && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 4. API 逻辑
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

    // 5. Webhook 处理
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

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleBotUpdate(update, config) {
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;
  if (chatId && text) {
    const reply = config.rules?.[text] || (text === "/start" ? "已激活" : null);
    if (reply) {
      await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: reply })
      });
    }
  }
  return new Response("OK");
}

const commonHead = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <style>
    input, textarea { font-size: 16px !important; } /* 防止移动端输入框放大 */
    .rule-card { transition: all 0.2s; }
    .rule-card:active { transform: scale(0.98); background: #f8fafc; }
  </style>
`;

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Login</title></head>
  <body class="bg-gray-100 flex items-center justify-center min-h-screen p-6">
    <div class="bg-white p-8 rounded-3xl shadow-xl w-full max-w-sm">
      <h1 class="text-2xl font-black mb-6 text-center text-gray-800">Bot Admin</h1>
      <div class="space-y-4">
        <input id="u" type="text" placeholder="User" class="w-full p-4 bg-gray-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500">
        <input id="p" type="password" placeholder="Pass" class="w-full p-4 bg-gray-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500">
        <button onclick="login()" id="btn" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all">登录</button>
      </div>
    </div>
    <script>
      async function login(){
        const btn = document.getElementById('btn');
        btn.disabled = true;
        const res = await fetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
        });
        if(res.ok) location.href='/admin'; else alert('失败');
        btn.disabled = false;
      }
    </script>
  </body></html>`;
}

function renderAdminHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Console</title></head>
  <body class="bg-slate-50 min-h-screen pb-10">
    <div id="app" class="max-w-2xl mx-auto p-4 sm:p-8">
      <div class="flex justify-between items-center mb-8">
        <h1 class="text-2xl font-black text-slate-800">我的机器人</h1>
        <button @click="openModal()" class="bg-blue-600 text-white px-6 py-2 rounded-full font-bold shadow-lg shadow-blue-200 active:scale-90 transition-all text-sm">＋ 添加</button>
      </div>

      <div class="grid gap-4">
        <div v-for="bot in bots" class="bg-white p-5 rounded-3xl shadow-sm border border-slate-100 flex justify-between items-center">
          <div class="truncate">
            <div class="font-bold text-slate-800 truncate">{{bot.name}}</div>
            <div class="text-[10px] text-slate-300 font-mono mt-1">{{bot.token.slice(0,12)}}...</div>
          </div>
          <button @click="editBot(bot)" class="bg-slate-50 text-blue-600 px-4 py-2 rounded-xl text-xs font-bold shrink-0">配置</button>
        </div>
      </div>

      <div v-if="showModal" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" @click="showModal=false"></div>
        <div class="relative bg-white w-full sm:max-w-xl rounded-t-[2.5rem] sm:rounded-3xl p-6 sm:p-8 shadow-2xl overflow-y-auto max-h-[90vh]">
          <div class="w-12 h-1 bg-slate-200 rounded-full mx-auto mb-6 sm:hidden"></div>
          <h2 class="text-xl font-black mb-6">{{isEdit ? '编辑配置' : '新增机器人'}}</h2>
          
          <div class="space-y-6">
            <div class="grid grid-cols-1 gap-4">
              <input v-model="form.name" placeholder="名称" class="w-full bg-slate-50 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm">
              <input v-model="form.token" placeholder="Bot Token" :disabled="isEdit" class="w-full bg-slate-50 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs">
            </div>

            <div>
              <div class="flex justify-between items-center mb-3">
                <label class="text-xs font-black text-slate-400 uppercase tracking-widest">自动回复规则</label>
                <button @click="uiMode = uiMode === 'visual' ? 'json' : 'visual'" class="text-blue-600 text-[10px] font-bold bg-blue-50 px-2 py-1 rounded">
                  切换到 {{uiMode === 'visual' ? 'JSON 源码' : '可视化界面'}}
                </button>
              </div>

              <div v-if="uiMode === 'visual'" class="space-y-3">
                <div v-for="(val, key, index) in ruleObject" :key="index" class="flex gap-2 items-start animate-in fade-in slide-in-from-right-2">
                  <input v-model="ruleKeys[index]" placeholder="关键字" @input="updateRulesFromUI" class="flex-1 bg-slate-50 p-3 rounded-xl text-xs border border-slate-100 outline-none">
                  <input v-model="ruleValues[index]" placeholder="回复内容" @input="updateRulesFromUI" class="flex-[1.5] bg-slate-50 p-3 rounded-xl text-xs border border-slate-100 outline-none">
                  <button @click="removeRule(index)" class="text-red-400 p-3">✕</button>
                </div>
                <button @click="addRule" class="w-full border-2 border-dashed border-slate-100 text-slate-400 py-3 rounded-2xl text-xs font-medium hover:border-blue-200 hover:text-blue-400 transition-colors">＋ 添加新规则</button>
              </div>

              <div v-else>
                <textarea v-model="form.rules" placeholder='{"/start": "你好"}' @input="updateUIFromRules" class="w-full bg-slate-900 text-green-400 p-4 rounded-2xl font-mono text-xs h-40 outline-none border-0 shadow-inner"></textarea>
              </div>
            </div>

            <button @click="save" :disabled="loading" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all shadow-xl disabled:bg-slate-200">
              {{ loading ? '同步 Telegram 中...' : '保存并生效' }}
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
            ruleKeys: [], ruleValues: []
          }
        },
        computed: {
          ruleObject() { try { return JSON.parse(this.form.rules); } catch(e) { return {}; } }
        },
        methods: {
          async load() { const r = await fetch('/api/bots'); this.bots = await r.json(); },
          openModal() {
            this.isEdit = false;
            this.form = { name: '', token: '', rules: '{"/start": "机器人已启动"}' };
            this.updateUIFromRules();
            this.showModal = true;
          },
          editBot(bot) {
            this.isEdit = true;
            this.form = { ...bot, rules: JSON.stringify(bot.rules) };
            this.updateUIFromRules();
            this.showModal = true;
          },
          // 核心逻辑：UI 数据双向同步
          updateUIFromRules() {
            try {
              const obj = JSON.parse(this.form.rules);
              this.ruleKeys = Object.keys(obj);
              this.ruleValues = Object.values(obj);
            } catch(e) {}
          },
          updateRulesFromUI() {
            const obj = {};
            this.ruleKeys.forEach((key, i) => { if(key) obj[key] = this.ruleValues[i]; });
            this.form.rules = JSON.stringify(obj, null, 2);
          },
          addRule() { this.ruleKeys.push(''); this.ruleValues.push(''); },
          removeRule(i) {
            this.ruleKeys.splice(i, 1);
            this.ruleValues.splice(i, 1);
            this.updateRulesFromUI();
          },
          async save() {
            this.loading = true;
            try {
              const res = await fetch('/api/save', {
                method: 'POST',
                body: JSON.stringify({ ...this.form, rules: JSON.parse(this.form.rules) })
              });
              if((await res.json()).success) { this.showModal = false; this.load(); }
              else alert('配置失败，请检查 Token');
            } catch(e) { alert('JSON 语法错误'); }
            this.loading = false;
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}