/**
 * Telegram Bot 管理系统 - 图文/文件混排增强版
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // --- 路由与基础 API (略，保持之前的登录/列表逻辑) ---
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
      await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
      return new Response(JSON.stringify({ success: true }));
    }

    // --- 核心：Webhook 增强逻辑 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("OK");
      
      const update = await request.json();
      const config = JSON.parse(configRaw);
      const msg = update.message;

      if (msg?.text) {
        const replyTemplate = config.rules?.[msg.text] || (msg.text === "/start" ? "已激活" : null);
        
        if (replyTemplate) {
          // 1. 提取第一个 URL
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const urls = replyTemplate.match(urlRegex);
          const firstUrl = urls ? urls[0] : null;
          
          // 2. 提取除 URL 以外的文字作为标题 (Caption)
          const caption = replyTemplate.replace(urlRegex, '').trim();

          let method = "sendMessage";
          let payload = { chat_id: msg.chat.id };

          if (firstUrl) {
            const isPhoto = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(firstUrl);
            const isDoc = /\.(pdf|zip|rar|7z|doc|docx|mp4|apk)(\?.*)?$/i.test(firstUrl);

            if (isPhoto) {
              method = "sendPhoto";
              payload.photo = firstUrl;
              payload.caption = caption;
            } else if (isDoc) {
              method = "sendDocument";
              payload.document = firstUrl;
              payload.caption = caption;
            } else {
              // 普通 URL，按文本发送
              payload.text = replyTemplate;
            }
          } else {
            payload.text = replyTemplate;
          }

          await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
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

/** 页面渲染 (UI 微调) **/
function renderAdminHTML() {
  const commonHead = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <style>input, textarea { font-size: 16px !important; } .modal-scroll { max-height: calc(100vh - 200px); overflow-y: auto; }</style>
  `;

  return `<!DOCTYPE html><html><head>${commonHead}<title>Admin</title></head>
  <body class="bg-slate-50 min-h-screen">
    <div id="app" class="max-w-xl mx-auto p-4 sm:p-8">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-xl font-bold text-slate-800">Bot Manager</h1>
        <button @click="openModal()" class="bg-blue-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-blue-100">添加机器人</button>
      </div>

      <div class="grid gap-3">
        <div v-for="bot in bots" class="bg-white p-4 rounded-2xl shadow-sm flex justify-between items-center border border-slate-100">
          <div class="truncate mr-4">
            <div class="font-bold text-slate-700">{{bot.name}}</div>
            <div class="text-[10px] text-slate-400 font-mono mt-1">{{bot.token.slice(0,16)}}...</div>
          </div>
          <button @click="editBot(bot)" class="text-blue-600 font-bold text-xs px-3 py-2 bg-blue-50 rounded-lg">配置</button>
        </div>
      </div>

      <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" @click="showModal=false"></div>
        <div class="relative bg-white w-full max-w-md rounded-3xl shadow-2xl flex flex-col max-h-[90vh]">
          <div class="p-6 border-b flex justify-between items-center">
            <h2 class="text-lg font-bold">机器人配置</h2>
            <button @click="showModal=false" class="text-slate-400 text-2xl">×</button>
          </div>
          
          <div class="p-6 modal-scroll space-y-6">
            <div class="space-y-3">
              <input v-model="form.name" placeholder="显示名称" class="w-full bg-slate-50 p-4 rounded-2xl outline-none text-sm">
              <input v-model="form.token" placeholder="Bot Token" :disabled="isEdit" class="w-full bg-slate-50 p-4 rounded-2xl outline-none font-mono text-xs">
            </div>

            <div>
              <div class="flex justify-between items-center mb-4">
                <label class="text-xs font-bold text-slate-400">回复规则 (支持文本+链接)</label>
                <button @click="uiMode = uiMode === 'visual' ? 'json' : 'visual'" class="text-blue-600 text-[10px] font-bold px-2 py-1 bg-blue-50 rounded">切换模式</button>
              </div>

              <div v-if="uiMode === 'visual'" class="space-y-4">
                <div v-for="(item, index) in rulesArray" :key="index" class="bg-slate-50 p-4 rounded-2xl relative border border-slate-100">
                  <div class="space-y-3">
                    <input v-model="item.key" @input="syncRules" placeholder="关键词" class="w-full bg-white p-3 rounded-xl text-sm shadow-sm outline-none border-0">
                    <textarea v-model="item.value" @input="syncRules" placeholder="回复内容... 放入图片链接会自动识别为图文消息" class="w-full bg-white p-3 rounded-xl text-sm shadow-sm outline-none border-0 h-24"></textarea>
                  </div>
                  <button @click="removeRule(index)" class="absolute -top-2 -right-2 bg-white text-red-500 w-6 h-6 rounded-full shadow-md text-[10px] flex items-center justify-center">✕</button>
                </div>
                <button @click="addRule" class="w-full py-4 border-2 border-dashed border-slate-200 text-slate-400 rounded-2xl text-xs font-bold hover:bg-white transition-all">＋ 添加回复规则</button>
              </div>

              <div v-else>
                <textarea v-model="form.rules" @input="syncArray" class="w-full bg-slate-900 text-green-400 p-4 rounded-2xl font-mono text-[11px] h-64 outline-none"></textarea>
              </div>
            </div>
          </div>

          <div class="p-6 border-t">
            <button @click="save" :disabled="loading" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl active:scale-95 disabled:bg-slate-200 shadow-lg shadow-blue-100 transition-all">
              {{ loading ? '正在保存...' : '确认并应用配置' }}
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
            rulesArray: []
          }
        },
        methods: {
          async load() { const r = await fetch('/api/bots'); this.bots = await r.json(); },
          openModal() {
            this.isEdit = false;
            this.form = { name: '', token: '', rules: '{"/start":"你好！"}' };
            this.syncArray();
            this.showModal = true;
          },
          editBot(bot) {
            this.isEdit = true;
            this.form = { ...bot, rules: JSON.stringify(bot.rules) };
            this.syncArray();
            this.showModal = true;
          },
          syncArray() {
            try {
              const obj = JSON.parse(this.form.rules);
              this.rulesArray = Object.keys(obj).map(k => ({ key: k, value: obj[k] }));
            } catch(e) { this.rulesArray = []; }
          },
          syncRules() {
            const obj = {};
            this.rulesArray.forEach(item => { if(item.key) obj[item.key] = item.value; });
            this.form.rules = JSON.stringify(obj, null, 2);
          },
          addRule() { this.rulesArray.push({ key: '', value: '' }); },
          removeRule(index) { this.rulesArray.splice(index, 1); this.syncRules(); },
          async save() {
            this.loading = true;
            try {
              await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...this.form, rules: JSON.parse(this.form.rules) })
              });
              this.showModal = false; this.load();
            } catch(e) { alert('保存失败，请检查格式'); }
            finally { this.loading = false; }
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><title>Login</title></head>
  <body class="bg-slate-100 flex items-center justify-center min-h-screen p-6 font-sans">
    <div class="bg-white p-10 rounded-[2.5rem] shadow-xl w-full max-w-sm text-center">
      <h1 class="text-3xl font-black mb-8 text-slate-800 tracking-tight">Bot Console</h1>
      <div class="space-y-4">
        <input id="u" type="text" placeholder="Username" class="w-full p-4 bg-slate-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 transition-all text-center">
        <input id="p" type="password" placeholder="Password" class="w-full p-4 bg-slate-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 transition-all text-center">
        <button onclick="login()" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all mt-4">登录系统</button>
      </div>
    </div>
    <script>
      async function login(){
        const res = await fetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
        });
        if(res.ok) location.href='/admin'; else alert('凭据错误');
      }
    </script>
  </body></html>`;
}