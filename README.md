# personallog.ai

**Your personal AI. Living in your repo.**

Open-source. Free. Deploys in 60 seconds on Cloudflare Workers.

---

## What is personallog.ai?

personallog.ai is a personal AI agent that lives inside your repository. Fork it, add your API key, deploy, and you have a fully working AI agent with:

- **Messenger-style web UI** — Chat with your agent like WhatsApp meets ChatGPT
- **Multi-channel** — Telegram, Discord, WhatsApp, email — one agent, everywhere
- **Persistent memory** — Remembers everything across all conversations and channels
- **File browser** — Browse and discuss your repo files directly in the chat
- **Agent-to-Agent (A2A)** — Expose an API for other agents to interact with yours
- **MCP server** — Standard tool protocol for visiting AI agents
- **The repo IS the agent** — Your agent has first-person awareness of its own codebase

Built on the [cocapn paradigm](https://github.com/nicobailon/cocapn): the repo IS the agent.

---

## Quick Start

### 1. Fork this repo

Click the Fork button on GitHub.

### 2. Set up Cloudflare

```bash
# Install wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create KV namespaces
wrangler kv namespace create MEMORY
wrangler kv namespace create FILES
wrangler kv namespace create ANALYTICS_KV
```

Update `wrangler.toml` with the KV namespace IDs from the output.

### 3. Add secrets

```bash
# Required
wrangler secret put DEEPSEEK_API_KEY

# Optional — password-protect your web app
wrangler secret put OWNER_PASSWORD

# Optional — for Telegram integration
wrangler secret put TELEGRAM_BOT_TOKEN

# Optional — for Discord integration
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_BOT_TOKEN

# Optional — for WhatsApp integration
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_ACCESS_TOKEN

# Optional — for GitHub repo file browser
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_REPO
```

Or set them as GitHub Secrets for auto-deploy.

### 4. Deploy

```bash
npm install
npm run deploy
```

Your agent is live at `https://personallog-ai.<your-subdomain>.workers.dev`

### 5. Customize your agent

Edit `template/soul.md` to change your agent's personality. Then upload it:

```bash
wrangler kv key put --binding MEMORY "soul.md" --path template/soul.md
```

Or set it via the web app's file browser.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Cloudflare Worker                   │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Landing Page │  │  Web App     │  │ WebSocket   │ │
│  │ GET /        │  │  GET /app    │  │  /ws        │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │              Agent Core                          │ │
│  │  soul.ts → memory.ts → context.ts → llm.ts     │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐ │
│  │ File Browser│  │ A2A Server │  │ MCP Server     │ │
│  │ /api/files  │  │ /api/a2a   │  │ /api/mcp       │ │
│  └────────────┘  └────────────┘  └────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          Multi-Channel Connectors                │ │
│  │  Telegram  │  Discord  │  WhatsApp  │  Email    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ MEMORY KV │  │ FILES KV │  │ ANALYTICS_KV     │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
                 DeepSeek API
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Landing page |
| GET | `/app` | Web app (auth required if OWNER_PASSWORD set) |
| POST | `/api/chat` | Chat with the agent (SSE streaming) |
| GET | `/api/files` | List repo files |
| GET | `/api/files/:path` | Read file content |
| POST | `/api/files/:path` | Write file (auth required) |
| GET | `/api/status` | Agent status |
| GET | `/api/analytics` | Usage analytics (auth required) |
| POST | `/api/a2a` | Agent-to-Agent protocol (JSON-RPC) |
| POST | `/api/mcp` | MCP tool server (JSON-RPC) |
| POST | `/api/channels/telegram` | Telegram webhook |
| POST | `/api/channels/discord` | Discord webhook |
| POST/GET | `/api/channels/whatsapp` | WhatsApp webhook |
| WS | `/ws` | Real-time WebSocket chat |

---

## Channel Setup

### Telegram

1. Message [@BotFather](https://t.me/BotFather) to create a bot
2. Get the bot token → set as `TELEGRAM_BOT_TOKEN`
3. Set webhook: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/api/channels/telegram`

### Discord

1. Create an application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Get public key and bot token → set as `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN`
3. Set interactions endpoint URL to `https://your-worker.workers.dev/api/channels/discord`

### WhatsApp (Meta Business)

1. Set up a Meta Business app with WhatsApp
2. Get verify token and access token → set as `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_ACCESS_TOKEN`
3. Configure webhook URL: `https://your-worker.workers.dev/api/channels/whatsapp`

---

## Customization

### Soul (Personality)

Edit `template/soul.md` to change your agent's personality. The soul is the agent's identity — its tone, capabilities, privacy rules, and behavior. Upload to KV:

```bash
wrangler kv key put --binding MEMORY "soul.md" --path template/soul.md
```

### Config

Edit `template/config.json` for channel toggles, model settings, and memory limits.

---

## A2A Protocol

Your agent exposes an Agent-to-Agent API at `/api/a2a`. Other agents can:

- **Discover** — `POST /api/a2a` with `{"type": "discover"}`
- **Greet** — `POST /api/a2a` with `{"type": "greet", "from": "their-agent-id"}`
- **Query** — `POST /api/a2a` with `{"type": "query", "payload": {...}}`
- **Message** — `POST /api/a2a` with `{"type": "message", "payload": {...}}`

Agent card available at: `GET /.well-known/agent.json`

---

## MCP Server

Your agent exposes MCP tools at `/api/mcp`. Available tools:

- `chat` — Send a message and get a response
- `list_files` — List files in the agent's storage
- `read_file` — Read a file by path
- `get_memory` — Retrieve a memory value

Standard JSON-RPC 2.0 protocol. Initialize with `{"method": "initialize"}`.

---

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# Deploy
npm run deploy

# View logs
npm run tail
```

---

## Free Tier

personallog.ai is designed to run entirely on Cloudflare Workers free tier:

- 100,000 requests/day
- 10ms CPU time per invocation
- 1GB KV storage
- No credit card required

The only cost is your DeepSeek API key (~$0.14 per million input tokens).

---

## License

MIT

---

Built with the [cocapn paradigm](https://github.com/nicobailon/cocapn) — the repo IS the agent.
