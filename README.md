# personallog.ai
**Your personal AI. Living in your repo.**

You don't need another chat tab. An agent that works for you should belong to you. This is that agent.

Fork this repository. It becomes your permanent, private AI. You control every line of code and every memory. It runs on Cloudflare's free tier, open source, with no upstream service.

---

## What it is
A deployable AI agent template. Once forked and deployed, you have a private agent with:
*   A web UI for chat.
*   Long-term memory using Cloudflare KV storage.
*   Optional native connections for Telegram, Discord, WhatsApp, and Email.
*   The ability to browse and discuss files in its own repository.
*   Support for the Model Context Protocol (MCP) for tools.
*   Agent-to-Agent communication for the Fleet network.

There is no hidden backend. The code you see is what runs.

---

## What makes it different
*   **You own the fork.** This is not a SaaS. Your repository is the complete agent.
*   **Memory is portable.** All memory is stored as plain text you can export.
*   **Zero lock-in.** No accounts, telemetry, or usage limits.
*   **Costs nothing to run.** Deploys to Cloudflare Workers' free tier.

It is built on the cocapn paradigm, where the repository is the agent's source of truth.

---

## Quick Start
1.  **Fork** this repository on GitHub.
2.  **Set up Cloudflare:**
    ```bash
    npm install -g wrangler
    wrangler login
    # Create the required KV namespaces and update `wrangler.toml`:
    wrangler kv namespace create MEMORY
    wrangler kv namespace create FILES
    wrangler kv namespace create ANALYTICS_KV
    ```
3.  **Add secrets** (e.g., `DEEPSEEK_API_KEY`) via `wrangler secret put` or GitHub Secrets.
4.  **Deploy:**
    ```bash
    npm install
    npm run deploy
    ```
5.  **Customize** your agent by editing `template/soul.md` and uploading it to the `MEMORY` KV store.

Your agent will be live at `https://personallog-ai.<your-subdomain>.workers.dev`.

---

## Honest Limitation
While you have full control, customizing tools or integrations requires editing code and redeploying. It's not a no-code platform.

---

## Architecture
The agent runs as a Cloudflare Worker. It uses KV namespaces for memory and file storage, and Durable Objects for real-time features. Integrations (Telegram, Discord, etc.) are implemented as separate, optional Worker routes.

---
Built by [Superinstance](https://superinstance.com) & [Lucineer](https://lucineer.ai) (DiGennaro et al.). Part of the Fleet.

<div>
  <a href="https://the-fleet.casey-digennaro.workers.dev">The Fleet</a> •
  <a href="https://cocapn.ai">Cocapn</a>
</div>

MIT License. Runs on Cloudflare Workers.