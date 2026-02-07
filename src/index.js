/**
 * Telegram Bot 管理系统 - 终极整合版
 * 功能：
 * 1. 修复添加规则按钮
 * 2. 采用分行显示的居中模态框（非抽屉）
 * 3. 智能识别图片/文件/API 链接，支持图文混排
 * 4. 自动处理随机图片 API 跳转
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // --- 路由处理 ---
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

    // --- 核心：智能 Webhook 逻辑 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("OK");
      
      const update = await request.json();
      const config = JSON.parse(configRaw);
      const msg = update.message;

      if (msg?.text) {
        let replyTemplate = config.rules?.[msg.text] || (msg.text === "/start" ? "机器人已就绪" : null);
        
        if (replyTemplate) {
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const urls = replyTemplate.match(urlRegex);
          let firstUrl = urls ? urls[0] : null;
          let caption = replyTemplate.replace(urlRegex, '').trim();

          let method = "sendMessage";
          let payload = { chat_id: msg.chat.id };

          if (firstUrl) {
            // 特殊处理：针对随机图片接口（如你提供的 moe API）
            // 如果链接包含 api 字样或没有常见文件后缀，尝试获取跳转后的真实地址
            if (firstUrl.includes("api") || !/\.(jpg|jpeg|png|gif|webp|pdf|zip|mp4|apk)/i.test(firstUrl)) {
              try {
                const apiRes = await fetch(firstUrl, { redirect: 'follow' });
                if (apiRes.url) firstUrl = apiRes.url;
              } catch (e) {}
            }

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

// --- UI 渲染函数 ---

const commonHead = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <style>
    input, textarea { font-size: 16px !important; }
    .modal-scroll { max-height: calc(100vh - 220px); overflow-y: auto; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
  </style>
`;

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Login</title></head>
  <body class="bg-slate-50 flex items-center justify-center min-h-screen p-6">
    <div class="bg-white p-10 rounded-[2.5rem] shadow-xl w-full max-w-sm">
      <h1 class="text-2xl font-black mb-8 text-center text-slate-800 tracking-tight">Bot Admin</h1>
      <div class="space-y-4">
        <input id="u" type="text" placeholder="账号" class="w-full p-4 bg-slate-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 transition-all text-center">
        <input id="p" type="password" placeholder="密码" class="w-full p-4 bg-slate-50 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 transition-all text-center">
        <button onclick="login()" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all mt-4 shadow-lg shadow-slate-200">登录</button>
      </div>
    </div>
    <script>
      async function login(){
        const res = await fetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value})
        });
        if(res.ok) location.href='/admin'; else alert('账号或密码错误');
      }
    </script>
  </body></html>`;
}

function renderAdminHTML() {
  return `<!DOCTYPE html><html><head>${commonHead}<title>Admin</title></head>
  <body class="bg-[#f8fafc] min-h-screen">
    <div id="app" class="max-w-xl mx-auto p-4 sm:p-8">
      <div class="flex justify-between items-center mb-8">
        <h1 class="text-2xl font-black text-slate-800">控制面板</h1>
        <button @click="openModal()" class="bg-blue-600 text-white px-6 py-2.5 rounded-2xl text-sm font-bold shadow-lg shadow-blue-100 hover:bg-blue-700 transition-all">添加机器人</button>
      </div>

      <div class="space-y-3">
        <div v-for="bot in bots" class="bg-white p-5 rounded-[2rem] shadow-sm flex justify-between items-center border border-slate-100">
          <div class="truncate mr-4">
            <div class="font-bold text-slate-800 text-base">{{bot.name}}</div>
            <div class="text-[10px] text-slate-400 font-mono mt-1 opacity-70">{{bot.token.slice(0,20)}}...</div>
          </div>
          <button @click="editBot(bot)" class="text-blue-600 font-bold text-xs px-4 py-2 bg-blue-50 rounded-xl hover:bg-blue-100 transition-colors">配置</button>
        </div>
        <div v-if="bots.length === 0" class="text-center py-20 text-slate-300 font-medium">暂无机器人，点击右上角添加</div>
      </div>

      <div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" @click="showModal=false"></div>
        <div class="relative bg-white w-full max-w-lg rounded-[2.5rem] shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
          <div class="p-8 border-b border-slate-50 flex justify-between items-center bg-white sticky top-0 z-10">
            <h2 class="text-xl font-black text-slate-800">{{isEdit ? '编辑机器人' : '新增机器人'}}</h2>
            <button @click="showModal=false" class="text-slate-300 hover:text-slate-500 text-2xl font-light">✕</button>
          </div>
          
          <div class="p-8 modal-scroll space-y-8">
            <div class="space-y-4">
              <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">基础配置</label>
              <input v-model="form.name" placeholder="机器人名称 (如: 我的小助手)" class="w-full bg-slate-50 p-4 rounded-2xl outline-none border border-transparent focus:border-blue-500 focus:bg-white transition-all">
              <input v-model="form.token" placeholder="Telegram Bot Token" :disabled="isEdit" class="w-full bg-slate-50 p-4 rounded-2xl outline-none font-mono text-xs border border-transparent focus:border-blue-500 focus:bg-white transition-all">
            </div>

            <div class="space-y-4">
              <div class="flex justify-between items-end ml-1">
                <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">关键词回复规则</label>
                <button @click="toggleMode" class="text-blue-600 text-[10px] font-bold px-2 py-1 bg-blue-50 rounded-lg">切换 {{uiMode === 'visual' ? 'JSON' : '可视化'}}</button>
              </div>

              <div v-if="uiMode === 'visual'" class="space-y-4">
                <div v-for="(item, index) in rulesArray" :key="index" class="bg-slate-50/50 p-5 rounded-[2rem] relative border border-slate-100 group hover:border-blue-200 transition-all">
                  <div class="space-y-4">
                    <div>
                       <div class="text-[10px] text-slate-400 mb-2 font-bold ml-1">当收到消息:</div>
                       <input v-model="item.key" @input="syncRules" placeholder="关键词" class="w-full bg-white p-3.5 rounded-xl text-sm shadow-sm border-0 outline-none focus:ring-2 focus:ring-blue-100">
                    </div>
                    <div>
                       <div class="text-[10px] text-slate-400 mb-2 font-bold ml-1">则回复:</div>
                       <textarea v-model="item.value" @input="syncRules" placeholder="内容或链接..." class="w-full bg-white p-3.5 rounded-xl text-sm shadow-sm border-0 outline-none focus:ring-2 focus:ring-blue-100 h-24 resize-none"></textarea>
                    </div>
                  </div>
                  <button @click="removeRule(index)" class="absolute -top-2 -right-2 bg-white text-red-500 shadow-md border border-red-50 w-7 h-7 rounded-full flex items-center justify-center hover:bg-red-500 hover:text-white transition-all">✕</button>
                </div>
                <button @click="addRule" class="w-full py-5 border-2 border-dashed border-slate-200 text-slate-400 rounded-[2rem] text-xs font-black hover:bg-slate-50 hover:border-blue-200 hover:text-blue-500 transition-all">＋ 添加新规则</button>
              </div>

              <div v-else>
                <textarea v-model="form.rules" @input="syncArray" class="w-full bg-slate-900 text-green-400 p-5 rounded-[2rem] font-mono text-[11px] h-64 outline-none border-4 border-slate-800 shadow-inner leading-relaxed"></textarea>
              </div>
            </div>
          </div>

          <div class="p-8 border-t border-slate-50 bg-white sticky bottom-0">
            <button @click="save" :disabled="loading" class="w-full bg-blue-600 text-white font-black py-4 rounded-2xl active:scale-95 disabled:bg-slate-200 shadow-xl shadow-blue-100 hover:bg-blue-700 transition-all flex items-center justify-center gap-2">
              <span v-if="loading" class="animate-spin text-lg">◌</span>
              {{ loading ? '同步中...' : '确认并应用到 Bot' }}
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
          async load() { 
            const r = await fetch('/api/bots'); 
            this.bots = await r.json(); 
          },
          openModal() {
            this.isEdit = false;
            this.form = { name: '', token: '', rules: '{"/start":"你好！"}' };
            this.syncArray();
            this.showModal = true;
          },
          editBot(bot) {
            this.isEdit = true;
            this.form = { ...bot, rules: JSON.stringify(bot.rules, null, 2) };
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
          addRule() {
            this.rulesArray.push({ key: '', value: '' });
          },
          removeRule(index) {
            this.rulesArray.splice(index, 1);
            this.syncRules();
          },
          toggleMode() {
            this.uiMode = this.uiMode === 'visual' ? 'json' : 'visual';
          },
          async save() {
            if(!this.form.name || !this.form.token) return alert('请填写完整信息');
            this.loading = true;
            try {
              const res = await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  ...this.form, 
                  rules: JSON.parse(this.form.rules) 
                })
              });
              if(res.ok) {
                this.showModal = false;
                this.load();
              }
            } catch(e) { alert('保存失败，请检查规则格式是否正确'); }
            finally { this.loading = false; }
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}