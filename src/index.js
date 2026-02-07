export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 管理界面 - HTML
    if (path === "/admin" && request.method === "GET") {
      return new Response(renderAdminHTML(), { headers: { "Content-Type": "text/html" } });
    }

    // 2. 管理 API - 处理添加机器人、设置 Webhook
    if (path === "/api/config" && request.method === "POST") {
      const { token, rules, commands } = await request.json();
      const tokenHash = await sha256(token);
      
      // 保存到 KV
      await env.TG_BOT_KV.put(`BOT_${tokenHash}`, JSON.stringify({ token, rules, commands }));

      // 自动设置 Telegram Webhook
      const webhookUrl = `https://${url.hostname}/webhook/${tokenHash}`;
      await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${webhookUrl}`);
      
      return new Response(JSON.stringify({ success: true, webhook: webhookUrl }));
    }

    // 3. Webhook 消息入口 - 支持多机器人
    if (path.startsWith("/webhook/")) {
      const tokenHash = path.split("/")[2];
      const configRaw = await env.TG_BOT_KV.get(`BOT_${tokenHash}`);
      if (!configRaw) return new Response("Unknown Bot", { status: 404 });

      const config = JSON.parse(configRaw);
      const update = await request.json();
      return await handleBotUpdate(update, config);
    }

    return new Response("Not Found", { status: 404 });
  }
};

// 简单的自动回复逻辑
async function handleBotUpdate(update, config) {
  if (update.message && update.message.text) {
    const text = update.message.text;
    const chatId = update.message.chat.id;

    // 匹配自动回复规则 (Simple Keywords)
    const reply = config.rules[text] || (text === "/start" ? "机器人已就绪！" : null);

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

// 辅助函数：计算 Hash 隐藏 Token
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function renderAdminHTML() {
  return `<!DOCTYPE html>...这里写你的管理网页代码...`;
      }
