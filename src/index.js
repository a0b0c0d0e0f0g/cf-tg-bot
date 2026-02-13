export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = Object.fromEntries(cookieHeader.split('; ').map(x => x.split('=')));
    const isAuthed = cookies['session'] === env.SESSION_SECRET;

    // --- 1. 管理后台 API ---
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

    // --- 2. 消息处理中心 ---
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const bot = await env.DB.prepare("SELECT token FROM bots WHERE token_hash = ?").bind(tokenHash).first();
      if (!bot) return new Response("OK");

      let update;
      try { update = await request.json(); } catch (e) { return new Response("OK"); }

      let incomingText = "", msgContext = null, userId = null;
      if (update.message?.text) {
        incomingText = update.message.text;
        msgContext = update.message;
        userId = update.message.from.id;
      } else if (update.callback_query) {
        incomingText = update.callback_query.data;
        msgContext = update.callback_query.message;
        userId = update.callback_query.from.id;
        await fetch(`https://api.telegram.org/bot${bot.token}/answerCallbackQuery`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: update.callback_query.id })
        });
      }

      if (incomingText && userId) {
        try {
          const rawParts = incomingText.trim().split(/\s+/).filter(p => p.length > 0);
          const cmd = rawParts[0]?.split('@')[0];
          const args = rawParts.slice(1);
          
          const data = await env.DB.prepare("SELECT c.rules FROM configs c JOIN bot_config_refs r ON c.id = r.config_id WHERE r.bot_hash = ?").bind(tokenHash).all();
          let rules = {};
          data.results.forEach(row => { try { Object.assign(rules, JSON.parse(row.rules)); } catch(e){} });

          let template = rules[cmd];
          if (template) {
            const parts = template.split("|||SEP|||");
            const bodyContent = parts[0] || "", btnArea = parts[1] || "", waitText = parts[2] || "", cooldownSec = parseInt(parts[3]) || 0;

            // --- 冷却拦截逻辑 ---
            if (cooldownSec > 0) {
              if (!env.LIMIT_KV) throw new Error("后台开启了冷却，但代码未绑定 LIMIT_KV 空间");
              const kvKey = `limit:${tokenHash}:${userId}:${cmd}`;
              const lastTime = await env.LIMIT_KV.get(kvKey);
              const now = Date.now();

              if (lastTime) {
                const diff = now - Number(lastTime);
                const waitMs = cooldownSec * 1000;
                if (diff < waitMs) {
                  const remain = Math.ceil((waitMs - diff) / 1000);
                  await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                      chat_id: msgContext.chat.id, 
                      text: `❄️ <b>冷却限制</b>\n\n请等待: <code>${remain}s</code>\n总间隔: <code>${cooldownSec}s</code>`,
                      parse_mode: "HTML"
                    })
                  });
                  return new Response("OK");
                }
              }
              // 先记时间，再发消息 (防并发连点)
              await env.LIMIT_KV.put(kvKey, now.toString(), { expirationTtl: Math.max(cooldownSec, 60) });
            }

            // --- 变量替换 ---
            let finalReply = template;
            for (let i = 1; i <= 9; i++) finalReply = finalReply.replace(new RegExp(`\\{\\{${i}\\}\\}`, 'g'), args[i-1] || "");
            finalReply = finalReply.replace(/\{\{name\}\}/g, args[0] || "");
            
            await handleBotReply(msgContext, bot.token, finalReply);
          }
        } catch (err) {
          // --- 报错反馈 ---
          await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: msgContext.chat.id, 
              text: `❌ <b>系统错误</b>\n原因: <code>${err.message}</code>`,
              parse_mode: "HTML"
            })
          });
        }
      }
      return new Response("OK");
    }

    if (path === "/login") return new Response(renderLoginHTML(), { headers: { "Content-Type": "text/html" } });
    if (!isAuthed) return Response.redirect(`${url.origin}/login`, 302);
    return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html" } });
  }
};

// --- 3. 附件/文本发送引擎 ---
async function handleBotReply(msg, token, reply) {
  const botUrl = `https://api.telegram.org/bot${token}`;
  const parts = reply.split("|||SEP|||");
  const bodyText = parts[0] || "", btnArea = parts[1] || "", waitText = parts[2] || "";

  let waitMsgId = null;
  if (waitText.trim()) {
    const res = await fetch(`${botUrl}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text: waitText })
    });
    if (res.ok) waitMsgId = (await res.json()).result.message_id;
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

  // 媒体探测 (逻辑增强)
  const urls = bodyText.match(/(https?:\/\/[^\s]+)/g);
  let firstUrl = urls ? urls[0] : null;
  let caption = bodyText.replace(/(https?:\/\/[^\s]+)/g, '').trim();

  let method = "sendMessage", payload = { 
    chat_id: msg.chat.id, parse_mode: "HTML",
    reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
  };

  // 判定是否为图片
  if (firstUrl && (/\.(jpg|jpeg|png|gif|webp|bmp)/i.test(firstUrl) || /(api|php|img|run|image|unsplash|random|pic)/i.test(firstUrl))) {
    method = "sendPhoto";
    payload.photo = `${firstUrl}${firstUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
    if (caption) payload.caption = caption;
  } else {
    payload.text = bodyText || "指令已执行";
  }

  const finalRes = await fetch(`${botUrl}/${method}`, { 
    method: "POST", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify(payload) 
  });

  if (!finalRes.ok) throw new Error(`TG返回错误: ${(await finalRes.json()).description}`);

  // 发送成功后删除“正在发送...”提示
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

// --- 4. 管理后台 HTML (Vue3 + Tailwind) ---
function renderAdminHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"><script src="https://cdn.tailwindcss.com"></script><script src="https://unpkg.com/vue@3/dist/vue.global.js"></script><title>BotMaster Admin</title>
  <style>[v-cloak] { display: none; } .full-drawer { position: fixed; inset: 0; z-index: 100; background: white; display: flex; flex-direction: column; }</style></head>
  <body class="bg-slate-50 text-slate-900 font-sans">
    <div id="app" v-cloak class="max-w-2xl mx-auto p-4 pb-24">
      <div class="flex gap-2 mb-6 bg-white p-1.5 rounded-2xl shadow-sm border sticky top-4 z-40">
        <button @click="tab='bots'" :class="tab==='bots'?'bg-blue-600 text-white shadow-lg':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">机器人管理</button>
        <button @click="tab='configs'" :class="tab==='configs'?'bg-blue-600 text-white shadow-lg':'text-slate-400'" class="flex-1 py-3 rounded-xl font-bold transition-all">规则仓库</button>
      </div>

      <div v-if="tab==='bots'" class="space-y-4">
        <div v-for="bot in bots" class="bg-white p-5 rounded-[2rem] border flex justify-between items-center shadow-sm">
          <div><p class="font-bold text-lg">{{bot.name}}</p></div>
          <button @click="editBot(bot)" class="bg-blue-50 text-blue-600 font-bold px-5 py-2 rounded-xl text-sm">编辑</button>
        </div>
        <button @click="openBotModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 添加新 Bot</button>
      </div>

      <div v-if="tab==='configs'" class="space-y-4">
        <div v-for="cfg in configs" class="bg-white p-6 rounded-[2rem] border flex justify-between items-center shadow-sm">
          <p class="font-bold text-lg">{{cfg.name}}</p>
          <button @click="editConfig(cfg)" class="bg-slate-900 text-white font-bold px-5 py-2 rounded-xl text-sm">管理规则</button>
        </div>
        <button @click="openConfigModal()" class="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2rem] text-slate-400 font-black">+ 创建新规则集</button>
      </div>

      <div v-if="showConfigModal" class="full-drawer">
        <div class="p-6 border-b flex justify-between items-center bg-white sticky top-0 z-10 shadow-sm">
          <button @click="showConfigModal=false" class="text-slate-400 font-bold">关闭</button>
          <h3 class="font-black text-xl">规则编辑器</h3>
          <button @click="saveConfig" class="text-blue-600 font-bold">保存</button>
        </div>
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          <section><label class="text-[10px] font-black text-slate-400 uppercase ml-1">规则集名称</label><input v-model="configForm.name" class="w-full bg-slate-50 p-4 rounded-2xl font-bold mt-2 outline-none border focus:border-blue-500"></section>
          <section><label class="text-[10px] font-black text-slate-400 uppercase ml-1">绑定到以下 Bot</label>
            <div class="flex flex-wrap gap-2 mt-2">
              <div v-for="bot in bots" @click="toggleBot(bot.token_hash)" :class="configForm.botHashes.includes(bot.token_hash)?'bg-blue-600 text-white shadow-md':'bg-white text-slate-400 border'" class="px-4 py-2 rounded-xl text-[10px] font-bold cursor-pointer transition-all">{{bot.name}}</div>
            </div>
          </section>
          <section>
            <label class="text-[10px] font-black text-slate-400 uppercase ml-1">指令详情 (SEP 分隔模式)</label>
            <div class="space-y-4 mt-3">
              <div v-for="(rule, idx) in rulesList" :key="idx" class="p-6 bg-slate-50 rounded-[2.5rem] border relative">
                <input v-model="rule.key" placeholder="/start" class="w-full bg-transparent font-mono font-bold text-blue-600 border-b pb-2 mb-4 outline-none">
                <div class="grid grid-cols-2 gap-3 mb-4">
                  <div><label class="text-[10px] font-bold text-slate-400">等待提示</label><input v-model="rule.wait" placeholder="正在发送..." class="w-full bg-white p-3 rounded-xl text-sm mt-1 outline-none"></div>
                  <div><label class="text-[10px] font-bold text-slate-400">冷却时间(秒)</label><input type="number" v-model="rule.cooldown" placeholder="0" class="w-full bg-white p-3 rounded-xl text-sm mt-1 outline-none"></div>
                </div>
                <div class="mb-4"><label class="text-[10px] font-bold text-slate-400">回复文本/图片链接</label><textarea v-model="rule.val" rows="3" class="w-full bg-white p-3 rounded-xl text-sm mt-1 outline-none"></textarea></div>
                <div><label class="text-[10px] font-bold text-slate-400">交互按钮 (格式: [文字|链接/指令])</label><input v-model="rule.btns" placeholder="[换一张|/bing]" class="w-full bg-white p-3 rounded-xl text-xs mt-1 outline-none font-mono"></div>
                <button @click="rulesList.splice(idx,1)" class="absolute -top-2 -right-2 bg-red-500 text-white w-8 h-8 rounded-full shadow-lg">✕</button>
              </div>
              <button @click="rulesList.push({key:'',val:'',btns:'',wait:'',cooldown:0})" class="w-full py-4 border-2 border-dashed border-slate-300 rounded-2xl text-slate-400 font-bold">+ 添加一条新规则</button>
            </div>
          </section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="configForm.id" @click="deleteConfig" class="bg-red-50 text-red-600 font-bold py-4 rounded-2xl text-sm">删除规则集</button>
          <button @click="saveConfig" :class="configForm.id?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">提交并应用</button>
        </div>
      </div>

      <div v-if="showBotModal" class="full-drawer">
        <div class="p-6 border-b flex justify-between items-center bg-white"><button @click="showBotModal=false" class="text-slate-400">取消</button><h3 class="font-black text-xl">Bot 配置</h3><div class="w-10"></div></div>
        <div class="p-6 space-y-6 flex-1">
          <section><label class="text-[10px] font-black text-slate-400 uppercase">备注名称</label><input v-model="botForm.name" class="w-full bg-slate-50 p-5 rounded-3xl mt-2 outline-none font-bold shadow-inner"></section>
          <section><label class="text-[10px] font-black text-slate-400 uppercase">Telegram Bot Token</label><textarea v-model="botForm.token" rows="4" class="w-full bg-slate-50 p-5 rounded-3xl mt-2 font-mono text-xs outline-none shadow-inner"></textarea></section>
        </div>
        <div class="p-6 bg-white border-t grid grid-cols-3 gap-3">
          <button v-if="botForm.token_hash" @click="deleteBot(botForm.token_hash)" class="bg-red-50 text-red-600 font-bold py-4 rounded-2xl text-sm">删除 Bot</button>
          <button @click="saveBot" :class="botForm.token_hash?'col-span-2':'col-span-3'" class="bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-xl">保存设置</button>
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
          async deleteBot(h) { if(confirm('确定删除该 Bot 及其 Webhook 绑定？')){ await fetch('/api/bot/delete',{method:'POST',body:JSON.stringify({token_hash:h})}); this.showBotModal=false; this.load(); } },
          async saveBot() { await fetch('/api/bot/save',{method:'POST',body:JSON.stringify(this.botForm)}); this.showBotModal=false; this.load(); },
          openConfigModal() { this.configForm={id:null,name:'',botHashes:[]}; this.rulesList=[{key:'/start',val:'',btns:'',wait:'',cooldown:0}]; this.showConfigModal=true; },
          editConfig(cfg) {
            this.configForm = { id: cfg.id, name: cfg.name, botHashes: this.refs.filter(r => r.config_id === cfg.id).map(r => r.bot_hash) };
            const raw = JSON.parse(cfg.rules || '{}');
            this.rulesList = Object.entries(raw).map(([k,v]) => {
              const p = v.split("|||SEP|||");
              return { key: k, val: p[0]||"", btns: p[1]||"", wait: p[2]||"", cooldown: p[3]||0 };
            });
            this.showConfigModal = true;
          },
          async deleteConfig() { if(confirm('确定删除该规则集？')){ await fetch('/api/config/delete',{method:'POST',body:JSON.stringify({id:this.configForm.id})}); this.showConfigModal=false; this.load(); } },
          toggleBot(h) { const i=this.configForm.botHashes.indexOf(h); if(i>-1) this.configForm.botHashes.splice(i,1); else this.configForm.botHashes.push(h); },
          async saveConfig() {
            const obj = {};
            this.rulesList.forEach(r => { if(r.key.trim()) obj[r.key.trim()] = r.val + "|||SEP|||" + r.btns + "|||SEP|||" + r.wait + "|||SEP|||" + r.cooldown; });
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 flex items-center justify-center min-h-screen p-6"><div class="bg-white p-10 rounded-[3rem] shadow-2xl w-full max-w-sm text-center"><h1 class="text-3xl font-black mb-8 tracking-tighter text-slate-800">BotMaster</h1><input id="u" type="text" placeholder="Account" class="w-full p-5 bg-slate-50 rounded-2xl mb-3 outline-none focus:ring-2 ring-blue-500 shadow-inner"><input id="p" type="password" placeholder="Password" class="w-full p-5 bg-slate-50 rounded-2xl mb-8 outline-none focus:ring-2 ring-blue-500 shadow-inner"><button onclick="login()" class="w-full bg-blue-600 text-white font-black py-5 rounded-2xl shadow-xl active:scale-95 transition-transform">立即登录</button></div><script>async function login(){const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});if(r.ok) location.href='/admin'; else alert('账号或密码错误');}</script></body></html>`;
}