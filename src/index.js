export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET;

    // --- 1. API 逻辑 (保持认证逻辑) ---
    if (path === "/api/login" && request.method === "POST") {
      const { user, pass } = await request.json();
      if (user === env.ADMIN_USER && pass === env.ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Set-Cookie": `session=${env.SESSION_SECRET}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`, "Content-Type": "application/json" }
        });
      }
      return new Response("Unauthorized", { status: 401 });
    }

    if (isAuthed) {
      if (path === "/api/data" && request.method === "GET") {
        const bots = (await env.DB.prepare("SELECT * FROM bots").all()).results;
        const configs = (await env.DB.prepare("SELECT * FROM configs").all()).results;
        const refs = (await env.DB.prepare("SELECT * FROM bot_config_refs").all()).results;
        return new Response(JSON.stringify({ bots, configs, refs }));
      }
      if (path === "/api/config/save" && request.method === "POST") {
        const { id, name, rules, botHashes } = await request.json();
        let configId = id;
        if (id) await env.DB.prepare("UPDATE configs SET name = ?, rules = ? WHERE id = ?").bind(name, rules, id).run();
        else {
          const res = await env.DB.prepare("INSERT INTO configs (name, rules) VALUES (?, ?)").bind(name, rules).run();
          configId = res.meta.last_row_id;
        }
        await env.DB.prepare("DELETE FROM bot_config_refs WHERE config_id = ?").bind(configId).run();
        if (botHashes?.length > 0) {
          const stmts = botHashes.map(h => env.DB.prepare("INSERT INTO bot_config_refs (bot_hash, config_id) VALUES (?, ?)").bind(h, configId));
          await env.DB.batch(stmts);
        }
        return new Response(JSON.stringify({ success: true }));
      }
      if (path === "/api/bot/save" && request.method === "POST") {
        const bot = await request.json();
        const tokenHash = await sha256(bot.token);
        await env.DB.prepare("INSERT INTO bots (token_hash, token, name) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET name=excluded.name, token=excluded.token").bind(tokenHash, bot.token, bot.name).run();
        await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=https://${url.hostname}/webhook/${tokenHash}`);
        return new Response(JSON.stringify({ success: true }));
      }
      if (path === "/api/bot/delete" && request.method === "POST") {
        const { token_hash } = await request.json();
        await env.DB.prepare("DELETE FROM bots WHERE token_hash = ?").bind(token_hash).run();
        return new Response(JSON.stringify({ success: true }));
      }
      if (path === "/api/config/delete" && request.method === "POST") {
        const { id } = await request.json();
        await env.DB.prepare("DELETE FROM configs WHERE id = ?").bind(id).run();
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // --- 2. Webhook 消息逻辑 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const bot = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(tokenHash).first();
      if (!bot) return new Response("OK");

      const update = await request.json();
      let incomingText = "", msgContext = null;

      if (update.message?.text) { incomingText = update.message.text; msgContext = update.message; } 
      else if (update.callback_query) {
        incomingText = update.callback_query.data;
        msgContext = update.callback_query.message;
        await fetch(`https://api.telegram.org/bot${bot.token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: update.callback_query.id })
        });
      }

      if (incomingText) {
        const rawParts = incomingText.trim().split(/\s+/).filter(p => p.length > 0);
        if (rawParts.length > 0) {
          const cmd = rawParts[0].split('@')[0];
          const args = rawParts.slice(1);
          const data = await env.DB.prepare("SELECT c.rules FROM configs c JOIN bot_config_refs r ON c.id = r.config_id WHERE r.bot_hash = ?").bind(tokenHash).all();
          let rules = {};
          data.results.forEach(row => { try { Object.assign(rules, JSON.parse(row.rules)); } catch(e){} });

          let template = rules[cmd];
          if (template) {
            let finalReply = template;
            for (let i = 1; i <= 9; i++) finalReply = finalReply.replace(new RegExp(`\\{\\{${i}\\}\\}`, 'g'), args[i-1] || "");
            finalReply = finalReply.replace(/\{\{name\}\}/g, args[0] || "");
            await handleBotReply(msgContext, bot.token, finalReply.trim());
          }
        }
      }
      return new Response("OK");
    }

    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html" } });
    if (!isAuthed) return Response.redirect(`${url.origin}/login`, 302);
    return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html" } });
  }
};

// --- 3. 核心回复逻辑：等待提示独立解析 ---
async function handleBotReply(msg, token, reply) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  
  // 拆分字段：文案|||按钮区|||等待提示
  const parts = reply.split("|||SEP|||");
  const bodyText = parts[0] || "";
  const btnArea = parts[1] || "";
  const waitText = parts[2] || "";

  let waitMsgId = null;
  if (waitText.trim()) {
    const waitRes = await fetch(`${botUrl}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: waitText })
    });
    if (waitRes.ok) {
      const d = await waitRes.json();
      waitMsgId = d.result.message_id;
    }
  }

  // 按钮解析
  const btnRegex = /\[([^\]|]+)\|([^\]]+)\]/g;
  let inline_keyboard = [];
  let currentRow = [];
  let match;
  while ((match = btnRegex.exec(btnArea)) !== null) {
    const text = match[1].trim(), target = match[2].trim();
    currentRow.push(target.startsWith('http') ? { text, url: target } : { text, callback_data: target });
    if (currentRow.length === 2) { inline_keyboard.push(currentRow); currentRow = []; }
  }
  if (currentRow.length > 0) inline_keyboard.push(currentRow);

  // 内容发送
  const urls = bodyText.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = bodyText.replace(/(https?:\/\/[^\s]+)/g, '').trim();

  let method = "sendMessage", payload = { 
    chat_id: msg.chat.id, parse_mode: "HTML",
    reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
  };

  if (firstUrl && (/\.(jpg|jpeg|png|gif|webp)/i.test(firstUrl) || /(api|php|img|run|image|unsplash|random|pic)/i.test(firstUrl))) {
    method = "sendPhoto";
    payload.photo = `${firstUrl}${firstUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    if (caption) payload.caption = caption;
  } else {
    payload.text = bodyText || "Done";
  }

  await fetch(`${botUrl}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (waitMsgId) {
    await fetch(`${botUrl}/deleteMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, message_id: waitMsgId })
    });
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- 4. 后台渲染 (支持 WAIT 文本框) ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>BotMaster v3</title>
  <style>[v-cloak] { display: none; } .full-drawer { position: fixed; inset: 0; z-index: 100; background: white; display: flex; flex-direction: column; }</style></head>
  <body class="bg-slate-50 text-slate-900">
    <div id="app" v-cloak class="max-w-2xl mx-auto p-4 pb-24">
      <div class="flex gap-2 mb-6 bg-white p-1.5 rounded-2xl shadow-sm border sticky top-4 z-40">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white shadow-lg':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white shadow-lg':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则库</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div v-for="bot in bots" class="bg-white p-5 rounded-[2rem] border flex justify-between items-center shadow-sm">
          <div><p class="font-bold text-lg text-slate-800">{{bot.name}}</p></div>
          <button @click="editBot(bot)" class="bg-blue-50 text-blue-600 font-bold px-5 py-2 rounded-xl text-sm">设置</button>
        </div>
        <button @click="openBotModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 添加机器人</button>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div v-for="cfg in configs" class="bg-white p-6 rounded-[2rem] border flex justify-between items-center shadow-sm">
          <p class="font-bold text-lg text-slate-800">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="bg-slate-900 text-white font-bold px-5 py-2 rounded-xl text-sm">编辑规则</button>
        </div>
        <button @click="openConfigModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 新建规则集</button>
      </div>

      <div v-if="showConfigModal" class="full-drawer animate-in slide-in-from-bottom duration-300">
        <div class="p-6 border-b flex justify-between items-center bg-white sticky top-0 z-10 shadow-sm">
          <button @click="showConfigModal=false" class="text-slate-400">取消</button>
          <h3 class="font-black text-xl">编辑规则集</h3>
          <button @click="saveConfig" class="text-blue-600 font-bold">保存</button>
        </div>
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          <section><label class="text-[10px] font-black text-slate-400 uppercase ml-1">规则集名称</label><input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold mt-2 outline-none border focus:border-blue-500"></section>
          <section><label class="text-[10px] font-black text-slate-400 uppercase ml-1">绑定机器人</label>
            <div class="flex flex-wrap gap-2 mt-2">
              <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white shadow-md':'bg-white text-slate-400 border'" class="px-4 py-2 rounded-xl text-[10px] font-bold cursor-pointer transition-all">{{bot.name}}</div>
            </div>
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase ml-1">指令规则配置</label>
            <div class="space-y-4 mt-3">
              <div v-for="(rule, idx) in rulesList" :key="idx" class="p-6 bg-slate-50 rounded-[2.5rem] border border-slate-200 relative shadow-inner">
                <input v-model="rule.key" placeholder="/指令" class="w-full bg-transparent font-mono font-bold text-blue-600 border-b border-slate-200 pb-2 mb-4 outline-none">
                
                <div class="mb-3">
                  <label class="text-[10px] font-black text-slate-500 uppercase">1. 等待提示 (可选，发送后自动删除)</label>
                  <input v-model="rule.wait" placeholder="例如：正在处理中..." class="w-full bg-white p-3 rounded-xl text-sm mt-1 outline-none shadow-sm">
                </div>

                <div class="mb-3">
                  <label class="text-[10px] font-black text-slate-500 uppercase">2. 回复文本 / 图片URL</label>
                  <textarea v-model="rule.val" rows="3" placeholder="支持 HTML" class="w-full bg-white p-3 rounded-xl text-sm mt-1 outline-none shadow-sm"></textarea>
                </div>

                <div>
                  <label class="text-[10px] font-black text-slate-500 uppercase">3. 交互按钮 [文字|链接或指令]</label>
                  <input v-model="rule.btns" placeholder="[文字|/cmd] [文字|https://...]" class="w-full bg-white p-3 rounded-xl text-xs mt-1 outline-none shadow-sm font-mono">
                </div>

                <button @click="rulesList.splice(idx,1)" class="absolute -top-2 -right-2 bg-white text-red-500 w-8 h-8 rounded-full shadow-md border flex items-center justify-center">✕</button>
              </div>
              <button @click="rulesList.push({key:'',val:'',btns:'',wait:''})" class="w-full py-4 border-2 border-dashed border-slate-300 rounded-2xl text-slate-400 font-bold">+ 新增指令卡片</button>
            </div>
          </section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="configForm.id" @click="deleteConfig" class="bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveConfig" :class="configForm.id?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">提交保存</button>
        </div>
      </div>

      <div v-if="showBotModal" class="full-drawer">
        <div class="p-6 border-b flex justify-between items-center bg-white"><button @click="showBotModal=false" class="text-slate-400">取消</button><h3 class="font-black text-xl">BOT 设置</h3><div class="w-10"></div></div>
        <div class="p-6 space-y-6 flex-1 overflow-y-auto">
          <section><label class="text-[10px] font-black text-slate-400 uppercase">备注名</label><input v-model="botForm.name" class="w-full bg-slate-50 p-5 rounded-3xl mt-2 outline-none font-bold"></section>
          <section><label class="text-[10px] font-black text-slate-400 uppercase">Token</label><textarea v-model="botForm.token" rows="4" class="w-full bg-slate-50 p-5 rounded-3xl mt-2 font-mono text-xs outline-none"></textarea></section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="botForm.token_hash" @click="deleteBot(botForm.token_hash)" class="bg-red-50 text-red-600 font-bold py-4 rounded-2xl">删除</button>
          <button @click="saveBot" :class="botForm.token_hash?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">保存</button>
        </div>
      </div>
    </div>
    <script>
      const { createApp } = Vue;
      createApp({
        data() { return { tab: 'bots', bots: [], configs: [], refs: [], showBotModal: false, showConfigModal: false, botForm: { name: '', token: '', token_hash: null }, configForm: { id: null, name: '', botHashes: [] }, rulesList: [] } },
        methods: {
          async load() { const r = await fetch('/api/data'); const d = await r.json(); this.bots = d.bots; this.configs = d.configs; this.refs = d.refs; },
          openBotModal() { this.botForm = { name: '', token: '', token_hash: null }; this.showBotModal = true; },
          editBot(bot) { this.botForm = { ...bot }; this.showBotModal = true; },
          async deleteBot(h) { if(confirm('删除Bot？')){ await fetch('/api/bot/delete',{method:'POST',body:JSON.stringify({token_hash:h})}); this.showBotModal=false; this.load(); } },
          async saveBot() { await fetch('/api/bot/save',{method:'POST',body:JSON.stringify(this.botForm)}); this.showBotModal=false; this.load(); },
          openConfigModal() { this.configForm={id:null,name:'',botHashes:[]}; this.rulesList=[{key:'/start',val:'',btns:'',wait:''}]; this.showConfigModal=true; },
          editConfig(cfg) {
            this.configForm = { id: cfg.id, name: cfg.name, botHashes: this.refs.filter(r => r.config_id === cfg.id).map(r => r.bot_hash) };
            const raw = JSON.parse(cfg.rules || '{}');
            this.rulesList = Object.entries(raw).map(([k,v]) => {
              const p = v.split("|||SEP|||");
              return { key: k, val: p[0]||"", btns: p[1]||"", wait: p[2]||"" };
            });
            this.showConfigModal = true;
          },
          async deleteConfig() { if(confirm('删除规则集？')){ await fetch('/api/config/delete',{method:'POST',body:JSON.stringify({id:this.configForm.id})}); this.showConfigModal=false; this.load(); } },
          toggleBot(h) { const i=this.configForm.botHashes.indexOf(h); if(i>-1) this.configForm.botHashes.splice(i,1); else this.configForm.botHashes.push(h); },
          async saveConfig() {
            const obj = {};
            this.rulesList.forEach(r => { if(r.key.trim()) obj[r.key.trim()] = r.val + "|||SEP|||" + r.btns + "|||SEP|||" + r.wait; });
            await fetch('/api/config/save',{method:'POST',body:JSON.stringify({...this.configForm, rules: JSON.stringify(obj)})});
            this.showConfigModal=false; this.load();
          }
        },
        mounted() { this.load(); }
      }).mount('#app')
    </script>
  </body></html>`;
}

function renderLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 flex items-center justify-center min-h-screen p-6"><div class="bg-white p-10 rounded-[3rem] shadow-2xl w-full max-w-sm text-center"><h1 class="text-3xl font-black mb-8 tracking-tighter text-slate-800">BotMaster</h1><input id="u" type="text" placeholder="Account" class="w-full p-5 bg-slate-50 rounded-2xl mb-3 outline-none focus:ring-2 ring-blue-500"><input id="p" type="password" placeholder="Password" class="w-full p-5 bg-slate-50 rounded-2xl mb-8 outline-none focus:ring-2 ring-blue-500"><button onclick="login()" class="w-full bg-blue-600 text-white font-black py-5 rounded-2xl shadow-xl active:scale-95 transition-transform">Login</button></div><script>async function login(){const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});if(r.ok) location.href='/admin'; else alert('Error');}</script></body></html>`;
}