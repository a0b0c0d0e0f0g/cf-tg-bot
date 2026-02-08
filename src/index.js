/**
 * Telegram Bot & D1 Storage 整合版
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET && env.SESSION_SECRET !== undefined;

    // --- 登录逻辑 ---
    if (path === "/login") {
      if (isAuthed) return Response.redirect(`${url.origin}/admin`, 302);
      return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`,
            "Content-Type": "application/json"
          }
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    // --- 管理接口 (D1 操作) ---
    if (isAuthed) {
      if (path === "/api/bots" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM bot_configs").all();
        const bots = results.map(b => ({ ...b, rules: JSON.parse(b.rules || '{}') }));
        return new Response(JSON.stringify(bots), { headers: { "Content-Type": "application/json" } });
      }

      if (path === "/api/save" && request.method === "POST") {
        const config = await request.json();
        const tokenHash = await sha256(config.token);
        const rulesStr = JSON.stringify(config.rules);
        
        await env.DB.prepare(`
          INSERT INTO bot_configs (token_hash, token, name, rules) 
          VALUES (?, ?, ?, ?)
          ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, rules=excluded.rules
        `).bind(tokenHash, config.token, config.name, rulesStr).run();

        await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
    }

    if (!isAuthed && (path === "/admin" || path === "/" || path.startsWith("/api/"))) {
      return Response.redirect(`${url.origin}/login`, 302);
    }

    if ((path === "/admin" || path === "/") && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // --- Webhook 核心逻辑 (带指令解析与状态管理) ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const config = await env.DB.prepare("SELECT * FROM bot_configs WHERE token_hash = ?").bind(tokenHash).first();
      if (!config) return new Response("OK");

      const update = await request.json();
      const msg = update.message;
      if (!msg?.text) return new Response("OK");

      // 1. 解析指令 (支持 /cmd@botname)
      const pureCommand = msg.text.split(' ')[0].split('@')[0];
      const rules = JSON.parse(config.rules || '{}');
      let replyTemplate = rules[pureCommand] || (pureCommand === "/start" ? "👋 机器人已就绪" : null);

      if (replyTemplate) {
        const botUrl = `https://api.telegram.org/bot${config.token}`;
        const urls = replyTemplate.match(/(https?:\/\/[^\s]+)/g);
        let firstUrl = urls ? urls[0] : null;
        let caption = replyTemplate.replace(/(https?:\/\/[^\s]+)/g, '').trim();
        let tempMsgId = null;

        // 2. 发送“正在获取”提示
        if (firstUrl) {
          try {
            const tRes = await fetch(`${botUrl}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: msg.chat.id, text: "⏳ 正在获取资源，请稍候...", disable_notification: true })
            });
            const tJson = await tRes.json();
            tempMsgId = tJson.result?.message_id;
          } catch (e) {}
        }

        try {
          let method = "sendMessage", payload = { chat_id: msg.chat.id };
          if (firstUrl) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            try {
              // 处理重定向 API
              if (firstUrl.includes("api") || !/\.(jpg|jpeg|png|gif|webp|pdf|zip|mp4|apk)/i.test(firstUrl)) {
                const apiRes = await fetch(firstUrl, { redirect: 'follow', signal: controller.signal });
                if (apiRes.url) firstUrl = apiRes.url;
              }
              clearTimeout(timeoutId);
            } catch (err) { throw new Error(err.name === 'AbortError' ? "timeout" : "连接失败"); }

            const isPhoto = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(firstUrl);
            const isDoc = /\.(pdf|zip|rar|7z|doc|docx|mp4|apk)(\?.*)?$/i.test(firstUrl);

            if (isPhoto) { method = "sendPhoto"; payload.photo = firstUrl; payload.caption = caption; }
            else if (isDoc) { method = "sendDocument"; payload.document = firstUrl; payload.caption = caption; }
            else { payload.text = replyTemplate; }
          } else {
            payload.text = replyTemplate;
          }

          // 发送最终资源
          const finalRes = await fetch(`${botUrl}/${method}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!finalRes.ok) throw new Error((await finalRes.json()).description || "发送失败");

          // 成功则删除提示
          if (tempMsgId) await fetch(`${botUrl}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id, message_id: tempMsgId }) });

        } catch (err) {
          const errorMsg = `❌ 获取资源失败: ${err.message}`;
          if (tempMsgId) await fetch(`${botUrl}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id, message_id: tempMsgId, text: errorMsg }) });
          else await fetch(`${botUrl}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id, text: errorMsg }) });
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

// --- UI 渲染函数 (与之前一致) ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><style>.modal-scroll { max-height: calc(100vh - 250px); overflow-y: auto; }::-webkit-scrollbar { width: 4px; }::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }</style><title>Bot Manager</title></head><body class="bg-[#f8fafc] min-h-screen"><div id="app" class="max-w-xl mx-auto p-4 sm:p-8"><div class="flex justify-between items-center mb-10"><h1 class="text-2xl font-black text-slate-800 tracking-tight">Bot Manager</h1><button @click="openModal()" class="bg-blue-600 text-white px-6 py-2.5 rounded-2xl text-sm font-bold shadow-lg shadow-blue-100 hover:scale-105 transition-all">添加 Bot</button></div><div class="space-y-4"><div v-for="bot in bots" class="bg-white p-5 rounded-[2rem] shadow-sm flex justify-between items-center border border-slate-100"><div class="truncate mr-4"><div class="font-bold text-slate-700">{{bot.name}}</div><div class="text-[10px] text-slate-400 font-mono mt-1">{{bot.token.slice(0,20)}}...</div></div><button @click="editBot(bot)" class="text-blue-600 font-bold text-xs px-4 py-2 bg-blue-50 rounded-xl">配置</button></div></div><div v-if="showModal" class="fixed inset-0 z-50 flex items-center justify-center p-4"><div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md" @click="showModal=false"></div><div class="relative bg-white w-full max-w-lg rounded-[2.5rem] shadow-2xl flex flex-col max-h-[90vh]"><div class="p-8 border-b flex justify-between items-center"><h2 class="text-xl font-black text-slate-800">机器人设置</h2><button @click="showModal=false" class="text-slate-300 text-2xl">✕</button></div><div class="p-8 modal-scroll space-y-6"><div class="space-y-4"><input v-model="form.name" placeholder="显示名称" class="w-full bg-slate-50 p-4 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500 transition-all"><input v-model="form.token" placeholder="Bot Token" :disabled="isEdit" class="w-full bg-slate-50 p-4 rounded-2xl outline-none font-mono text-xs border-2 border-transparent focus:border-blue-500 transition-all"></div><div class="space-y-4"><div class="flex justify-between items-center"><span class="text-xs font-bold text-slate-400 uppercase tracking-widest">回复规则</span><button @click="toggleMode" class="text-blue-600 text-[10px] font-bold px-2 py-1 bg-blue-50 rounded">切换模式</button></div><div v-if="uiMode === 'visual'" class="space-y-4"><div v-for="(item, index) in rulesArray" :key="index" class="bg-slate-50 p-5 rounded-3xl relative border border-slate-100"><input v-model="item.key" @input="syncRules" placeholder="关键词 (/cmd)" class="w-full bg-white p-3 rounded-xl text-sm mb-3 outline-none shadow-sm"><textarea v-model="item.value" @input="syncRules" placeholder="内容/链接" class="w-full bg-white p-3 rounded-xl text-sm outline-none shadow-sm h-24 resize-none"></textarea><button @click="removeRule(index)" class="absolute -top-2 -right-2 bg-white text-red-500 shadow-md w-7 h-7 rounded-full flex items-center justify-center">✕</button></div><button @click="addRule" class="w-full py-4 border-2 border-dashed border-slate-200 text-slate-400 rounded-3xl text-xs font-bold hover:bg-slate-50 transition-all">＋ 添加规则</button></div><textarea v-else v-model="form.rules" @input="syncArray" class="w-full bg-slate-900 text-green-400 p-5 rounded-3xl font-mono text-[11px] h-64 outline-none"></textarea></div></div><div class="p-8 border-t"><button @click="save" :disabled="loading" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl active:scale-95 shadow-lg shadow-blue-100 transition-all">{{ loading ? '同步中...' : '保存配置' }}</button></div></div></div></div><script>const { createApp } = Vue;createApp({data() {return {bots: [], showModal: false, loading: false, isEdit: false, uiMode: 'visual',form: { name: '', token: '', rules: '{}' }, rulesArray: []}},methods: {async load() { const r = await fetch('/api/bots'); this.bots = await r.json(); },openModal() { this.isEdit = false; this.form = { name: '', token: '', rules: '{"/start":"你好"}' }; this.syncArray(); this.showModal = true; },editBot(bot) { this.isEdit = true; this.form = { ...bot, rules: JSON.stringify(bot.rules, null, 2) }; this.syncArray(); this.showModal = true; },syncArray() { try { const obj = JSON.parse(this.form.rules); this.rulesArray = Object.keys(obj).map(k => ({ key: k, value: obj[k] })); } catch(e) {} },syncRules() { const obj = {}; this.rulesArray.forEach(i => { if(i.key) obj[i.key] = i.value; }); this.form.rules = JSON.stringify(obj, null, 2); },addRule() { this.rulesArray.push({ key: '', value: '' }); },removeRule(idx) { this.rulesArray.splice(idx, 1); this.syncRules(); },toggleMode() { this.uiMode = this.uiMode === 'visual' ? 'json' : 'visual'; },async save() {this.loading = true;try {await fetch('/api/save', { method: 'POST', body: JSON.stringify({ ...this.form, rules: JSON.parse(this.form.rules) }) });this.showModal = false; this.load();} catch(e) { alert('保存失败'); } finally { this.loading = false; }}},mounted() { this.load(); }}).mount('#app')</script></body></html>`;
}

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><title>Login</title></head><body class="bg-slate-50 flex items-center justify-center min-h-screen p-6 font-sans"><div class="bg-white p-10 rounded-[2.5rem] shadow-xl w-full max-w-sm"><h1 class="text-3xl font-black mb-10 text-center text-slate-800">Login</h1><div class="space-y-4"><input id="u" type="text" placeholder="账号" class="w-full p-4 bg-slate-50 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500 transition-all text-center"><input id="p" type="password" placeholder="密码" class="w-full p-4 bg-slate-50 rounded-2xl outline-none border-2 border-transparent focus:border-blue-500 transition-all text-center"><button onclick="login()" class="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl active:scale-95 transition-all mt-4">进入管理后台</button></div></div><script>async function login(){const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value}) });if(res.ok) location.href='/admin'; else alert('凭据错误');}</script></body></html>`;
}