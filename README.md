# personallog — Your AI agent lives in your repo

Your AI agent runs from a GitHub fork you control, deployed as a single Cloudflare Worker. No third-party servers hold its memory or API keys. This project is open source (MIT) and has zero dependencies.

**Live demo:** [personallog.ai](https://personallog.ai)
**Fork and deploy your own:** [github.com/cocapn/personallog](https://github.com/cocapn/personallog)

## Quick start
You can have a running agent in a few minutes.
1.  **Fork** this repository.
2.  Deploy to Cloudflare Workers (free tier):
    ```bash
    npm install -g wrangler
    wrangler login
    wrangler kv namespace create MEMORY
    wrangler kv namespace create FILES
    npm run deploy
    ```
3.  Edit `template/soul.md` to define your agent's personality and upload it.

Your agent will be live at your Worker URL.

## What it does
- Provides a clean, real-time web UI for streaming chat.
- Maintains long-term memory in a readable, editable text log.
- Connects to external platforms (Telegram, Discord, WhatsApp, email) via webhooks.
- Can read and reference any file in your forked repository.
- Supports Model Context Protocol for tools.
- Can communicate with other agents in the Cocapn Fleet network.
- No telemetry, user accounts, or usage limits are imposed by the code.

## How this is different
1.  **No central service.** Every instance is independent. Prompts and memory never pass through our infrastructure.
2.  **Transparent and simple.** The entire worker is about 1200 lines of plain JavaScript.
3.  **Fork-first.** You own the copy. We will not push updates or breaking changes to your repository.

## Honest limitation
The Cloudflare Workers free tier allows 100,000 requests per day. If you exceed this, your agent will stop responding until the next 24-hour cycle. For higher traffic, you must upgrade your Cloudflare plan.

<div style="text-align:center;padding:16px;color:#64748b;font-size:.8rem"><a href="https://the-fleet.casey-digennaro.workers.dev" style="color:#64748b">The Fleet</a> &middot; <a href="https://cocapn.ai" style="color:#64748b">Cocapn</a></div>