export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 管理后台页面
    if (path === "/admin" && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // 2. API: 获取机器人列表 (简单示例，实际可根据 KV 键名前缀列出)
    if (path === "/api/bots" && request.method === "GET") {
      const list = await env.TG_BOT_KV.list({ prefix: "BOT_" });
      const bots = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.TG_BOT_KV.get(k.name))));
      return new Response(JSON.stringify(bots), { headers: { "Content-Type": "application/json" } });
    }

    // 3. API: 保存机器人配置并绑定 Webhook
    if (path === "/api/save" && request.method === "POST") {
      try {
        const config = await request.json(); // { token, name, rules, commands }
        const tokenHash = await sha256(config.token);
        
        // 保存到 KV
        await env.TG_BOT_KV.put(`BOT_${tokenHash}`, JSON.stringify(config));

        // 自动设置 Webhook
        const webhookUrl = `https://${url.hostname}/webhook/${tokenHash}`;
        const tgRes = await fetch(`https://api.telegram.org/bot${config.token}/setWebhook?url=${webhookUrl}`);
        const tgData = await tgRes.json();

        return new Response(JSON.stringify({ success: tgData.ok, msg: tgData.description }));
      } catch (e) {
        return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500 });
      }
    }

    // 4. Webhook 入口
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("Bot Config Not Found", { status: 404 });

      const config = JSON.parse(configRaw);
      const update = await request.json();
      return await handleBotUpdate(update, config);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// 消息处理逻辑
async function handleBotUpdate(update, config) {
  if (update.message && update.message.text) {
    const text = update.message.text;
    const chatId = update.message.chat.id;

    // 匹配自动回复规则
    let replyText = config.rules[text];

    // 如果是 /start 命令且没有自定义，给个默认回复
    if (!replyText && text === "/start") replyText = "你好！我是管理系统托管的机器人。";

    if (replyText) {
      await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: replyText })
      });
    }
  }
  return new Response("OK");
}

// 辅助函数：哈希处理
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- 管理后台网页 ---
function renderAdminHTML() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>cf-tg-bot 管理系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  </head>
  <body class="bg-gray-100 p-8">
    <div id="app" class="max-w-4xl mx-auto">
      <header class="flex justify-between items-center mb-8">
        <h1 class="text-3xl font-bold text-blue-600">Bot Manager</h1>
        <button @click="showAddModal = true" class="bg-blue-500 text-white px-4 py-2 rounded shadow">添加机器人</button>
      </header>

      <div class="grid gap-4">
        <div v-for="bot in bots" :key="bot.token" class="bg-white p-6 rounded-lg shadow-md flex justify-between items-center">
          <div>
            <h3 class="text-xl font-semibold">{{ bot.name || '未命名机器人' }}</h3>
            <p class="text-gray-500 text-sm">Token: {{ bot.token.substring(0,10) }}...</p>
          </div>
          <button @click="editBot(bot)" class="text-blue-500 hover:underline">编辑配置</button>
        </div>
      </div>

      <div v-if="showAddModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-lg p-6 w-full max-w-md">
          <h2 class="text-xl font-bold mb-4">{{ isEdit ? '编辑机器人' : '添加机器人' }}</h2>
          <div class="space-y-4">
            <input v-model="form.name" placeholder="机器人名称" class="w-full border p-2 rounded">
            <input v-model="form.token" placeholder="Bot Token" class="w-full border p-2 rounded" :disabled="isEdit">
            <div>
              <label class="block text-sm font-medium mb-1">自动回复 (JSON格式)</label>
              <textarea v-model="form.rules" placeholder='{"你好": "哈喽！"}' class="w-full border p-2 rounded h-24 font-mono text-sm"></textarea>
            </div>
            <div class="flex justify-end space-x-2 mt-4">
              <button @click="showAddModal = false" class="bg-gray-300 px-4 py-2 rounded">取消</button>
              <button @click="saveBot" class="bg-blue-500 text-white px-4 py-2 rounded">保存并激活</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;
      createApp({
        data() {
          return {
            bots: [],
            showAddModal: false,
            isEdit: false,
            form: { name: '', token: '', rules: '{}' }
          }
        },
        methods: {
          async fetchBots() {
            const res = await fetch('/api/bots');
            this.bots = await res.json();
          },
          async saveBot() {
            const payload = { 
              ...this.form, 
              rules: JSON.parse(this.form.rules || '{}') 
            };
            const res = await fetch('/api/save', {
              method: 'POST',
              body: JSON.stringify(payload)
            });
            const result = await res.json();
            if(result.success) {
              alert('保存成功且 Webhook 已绑定！');
              this.showAddModal = false;
              this.fetchBots();
            } else {
              alert('失败: ' + result.msg);
            }
          },
          editBot(bot) {
            this.isEdit = true;
            this.form = { ...bot, rules: JSON.stringify(bot.rules, null, 2) };
            this.showAddModal = true;
          }
        },
        mounted() { this.fetchBots(); }
      }).mount('#app')
    </script>
  </body>
  </html>
  `;
}