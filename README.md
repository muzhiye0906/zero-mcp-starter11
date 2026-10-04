# 零度专属 MCP

这是零度的 Search + Weather 专属 MCP。部署后，它只属于你的 Cloudflare 账号；Jina 与 WeatherAPI Key 只填写在 Cloudflare，不会进入零度网页或聊天内容。

## 部署前准备

先准备两个 Key：

1. Jina API Key，用于上网搜索和读取公开网页。
2. WeatherAPI Key，用于实时天气和天气预报。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kittyliio257-design/zero-mcp-starter)

部署时按页面提示完成：

1. 点击 Deploy to Cloudflare。
2. 登录或注册 Cloudflare。
3. 填写 `JINA_API_KEY`。
4. 填写 `WEATHERAPI_KEY`。
5. 确认部署。
6. 复制部署结果中的专属云端网址。
7. 回到零度，粘贴地址并连接。

不需要安装 Node.js、Wrangler，也不需要打开命令行。

## 可用能力

Search：

- `search_web`：搜索公开网页。
- `read_webpage`：读取公开网页正文。

Weather：

- `get_current_weather`：查询实时天气。
- `get_weather_forecast`：查询 1 至 7 天天气预报。

默认允许零度正式站点 `https://freverzeroloveowo.top` 与零度 Android 应用连接（应用内页面来源为 `https://localhost`，请不要删除这一项，否则手机端会被拒绝）。高级用户可以在 `wrangler.toml` 的 `ALLOWED_ORIGINS` 中增加自己的开发地址，多个地址使用英文逗号分隔。

<details>
<summary>高级手动部署</summary>

此方式仅供熟悉 Cloudflare Workers 的用户使用。

```bash
npm install
npx wrangler login
npx wrangler secret put JINA_API_KEY
npx wrangler secret put WEATHERAPI_KEY
npm run deploy
```

本地开发时，可以从 `.env.example` 创建未纳入 Git 的 `.env`，并填写两个 Key。不要提交包含真实 Key 的文件。

</details>
