/**
 * PersonalLog Worker — main Cloudflare Worker for personallog.ai
 *
 * Single-file router handling all HTTP, WebSocket, and webhook traffic.
 * Runs on Cloudflare Workers with KV-backed memory and DeepSeek LLM.
 *
 * Routes:
 *   GET  /                       Landing page (public)
 *   GET  /app                    Web app (authenticated)
 *   POST /api/chat               Chat with SSE streaming from DeepSeek
 *   GET  /api/files              List files from GitHub or FILES KV
 *   GET  /api/files/:path        Read file content
 *   POST /api/files/:path        Write file to FILES KV (owner only)
 *   GET  /api/status             Agent status (soul, memory count, uptime)
 *   GET  /api/analytics          Usage stats from ANALYTICS_KV (owner only)
 *   POST /api/a2a/*              Agent-to-agent JSON-RPC handler
 *   POST /api/mcp/*              MCP tool exposure for visiting agents
 *   POST /api/channels/telegram  Telegram webhook
 *   POST /api/channels/discord   Discord webhook
 *   POST /api/channels/whatsapp  WhatsApp webhook
 *   WebSocket /ws                Real-time chat upgrade
 *
 * Deploy: wrangler deploy
 * Secrets: wrangler secret put DEEPSEEK_API_KEY
 */

import { SoulCompiler } from './agent/soul.js';
import { verifyTelegramAuth, handleTelegramMessage } from './channels/telegram.js';
import { verifyDiscordInteraction, handleDiscordEvent } from './channels/discord.js';
import { verifyWhatsAppWebhook, handleWhatsAppEvent } from './channels/whatsapp.js';

// ─── Environment Bindings ───────────────────────────────────────────────────────

export interface Env {
  MEMORY: KVNamespace;
  FILES: KVNamespace;
  ANALYTICS_KV: KVNamespace;
  DEEPSEEK_API_KEY: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  OWNER_PASSWORD?: string;
}

// ─── Types ──────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ConversationRecord {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

interface AgentStatus {
  ok: boolean;
  soulLoaded: boolean;
  soulName: string;
  memoryCount: number;
  uptime: number;
  version: string;
  timestamp: string;
}

interface FileEntry {
  path: string;
  size: number;
  modified: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
const DEEPSEEK_CHAT_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const MAX_CONVERSATION_MESSAGES = 100;
const WORKER_START_TIME = Date.now();
const MAX_SSE_TOKENS = 4096;

const soulCompiler = new SoulCompiler();

// ─── CORS Helpers ───────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(data: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function errorResponse(message: string, status: number): Response {
  return withCors(new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

function isAuthenticated(request: Request, env: Env): boolean {
  if (!env.OWNER_PASSWORD) return true;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return timingSafeEqual(token, env.OWNER_PASSWORD);
  }

  return false;
}

function requireAuth(request: Request, env: Env): Response | null {
  if (isAuthenticated(request, env)) return null;
  return errorResponse('Unauthorized — provide Bearer token via Authorization header', 401);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return a.length === b.length && crypto.subtle.timingSafeEqual !== undefined;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─── Soul Loading ───────────────────────────────────────────────────────────────

async function buildSystemPrompt(env: Env): Promise<string> {
  const soulMd = await env.MEMORY.get('soul.md');
  if (!soulMd) {
    return 'You are a helpful personal AI assistant running on personallog.ai. Be concise, friendly, and helpful.';
  }

  const compiled = soulCompiler.compile(soulMd);
  if (compiled.publicSystemPrompt) {
    return compiled.publicSystemPrompt;
  }
  if (compiled.systemPrompt) {
    return compiled.systemPrompt;
  }
  return 'You are a helpful personal AI assistant running on personallog.ai.';
}

// ─── Analytics ──────────────────────────────────────────────────────────────────

async function recordEvent(env: Env, event: string, meta?: Record<string, unknown>): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const key = `events:${today}`;

  const existing = await env.ANALYTICS_KV.get(key);
  const events: Array<{ event: string; meta?: Record<string, unknown>; ts: string }> =
    existing ? JSON.parse(existing) : [];

  events.push({ event, meta, ts: new Date().toISOString() });

  // Keep last 1000 events per day to prevent unbounded growth
  const trimmed = events.slice(-1000);
  await env.ANALYTICS_KV.put(key, JSON.stringify(trimmed), { expirationTtl: 90 * 24 * 3600 });
}

// ─── Embedded HTML Fallbacks ────────────────────────────────────────────────────

const FALLBACK_LANDING = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>personallog.ai — Your personal AI. Living in your repo.</title>
<meta name="description" content="Open-source personal AI agent. Deploys in 60 seconds on Cloudflare Workers. Free, private, and fully yours.">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg-primary: #0a0a0f;
  --bg-secondary: #111118;
  --bg-card: rgba(17, 17, 28, 0.6);
  --border-card: rgba(99, 102, 241, 0.15);
  --border-card-hover: rgba(99, 102, 241, 0.35);
  --text-primary: #eeeef0;
  --text-secondary: #9898a6;
  --text-muted: #5a5a6e;
  --accent: #6366f1;
  --accent-purple: #8b5cf6;
  --gradient: linear-gradient(135deg, #6366f1, #8b5cf6);
  --gradient-text: linear-gradient(135deg, #818cf8, #a78bfa);
  --font-stack: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --max-width: 1120px;
  --radius: 16px;
  --radius-sm: 10px;
}

html { scroll-behavior: smooth; }

body {
  font-family: var(--font-stack);
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.6;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a { color: inherit; text-decoration: none; }

.container { max-width: var(--max-width); margin: 0 auto; padding: 0 24px; }

/* ── Nav ─────────────────────────────────────────── */
nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  background: rgba(10, 10, 15, 0.8);
  border-bottom: 1px solid rgba(99, 102, 241, 0.08);
}
nav .container {
  display: flex; align-items: center; justify-content: space-between;
  height: 64px;
}
.logo {
  font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em;
  background: var(--gradient-text); -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.nav-links { display: flex; align-items: center; gap: 32px; }
.nav-links a {
  font-size: 0.875rem; color: var(--text-secondary); transition: color 0.2s;
}
.nav-links a:hover { color: var(--text-primary); }
.btn-cta {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 18px; border-radius: 8px; font-size: 0.8rem; font-weight: 600;
  background: var(--gradient); color: #fff; border: none; cursor: pointer;
  transition: opacity 0.2s, transform 0.2s;
}
.btn-cta:hover { opacity: 0.9; transform: translateY(-1px); }
.mobile-toggle { display: none; background: none; border: none; cursor: pointer; padding: 4px; }
.mobile-toggle span { display: block; width: 22px; height: 2px; background: var(--text-secondary); margin: 5px 0; border-radius: 2px; transition: 0.3s; }

/* ── Hero ────────────────────────────────────────── */
.hero {
  position: relative; min-height: 100vh; display: flex; align-items: center;
  justify-content: center; text-align: center; padding: 120px 24px 80px;
  overflow: hidden;
}
.hero-bg {
  position: absolute; inset: 0; z-index: 0;
  background:
    radial-gradient(ellipse 80% 50% at 50% -20%, rgba(99, 102, 241, 0.15), transparent),
    radial-gradient(ellipse 60% 40% at 80% 50%, rgba(139, 92, 246, 0.08), transparent),
    radial-gradient(ellipse 60% 40% at 20% 60%, rgba(99, 102, 241, 0.06), transparent);
}
.hero-mesh {
  position: absolute; inset: 0; z-index: 0; opacity: 0.4;
  background:
    radial-gradient(circle at 30% 40%, rgba(99, 102, 241, 0.12) 0%, transparent 50%),
    radial-gradient(circle at 70% 60%, rgba(139, 92, 246, 0.10) 0%, transparent 50%);
  animation: meshDrift 12s ease-in-out infinite alternate;
}
@keyframes meshDrift {
  0%   { transform: scale(1) translate(0, 0); }
  50%  { transform: scale(1.05) translate(-10px, 15px); }
  100% { transform: scale(1) translate(10px, -10px); }
}
.hero-particles { position: absolute; inset: 0; z-index: 0; }
.particle {
  position: absolute; border-radius: 50%;
  background: rgba(99, 102, 241, 0.3);
  animation: particleFloat linear infinite;
}
@keyframes particleFloat {
  0%   { transform: translateY(0) scale(1); opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  100% { transform: translateY(-100vh) scale(0.3); opacity: 0; }
}
.hero-content { position: relative; z-index: 1; max-width: 720px; }
.hero-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 16px; border-radius: 100px; font-size: 0.75rem; font-weight: 500;
  background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.2);
  color: #a5b4fc; margin-bottom: 32px;
}
.hero-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: #6366f1; animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.hero h1 {
  font-size: clamp(2.5rem, 6vw, 4.2rem); font-weight: 800; letter-spacing: -0.035em;
  line-height: 1.1; margin-bottom: 24px;
}
.hero h1 .gradient-word {
  background: var(--gradient-text); -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero p {
  font-size: 1.15rem; color: var(--text-secondary); max-width: 540px;
  margin: 0 auto 40px; line-height: 1.7;
}
.typing-cursor {
  display: inline-block;
  color: var(--accent);
  animation: blink 1s step-end infinite;
  font-weight: 100;
}
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
.hero-buttons { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
.btn-hero {
  padding: 14px 32px; border-radius: var(--radius-sm); font-size: 0.95rem; font-weight: 600;
  cursor: pointer; transition: all 0.25s; border: none;
}
.btn-hero.primary {
  background: var(--gradient); color: #fff;
  box-shadow: 0 0 30px rgba(99, 102, 241, 0.25);
}
.btn-hero.primary:hover { box-shadow: 0 0 50px rgba(99, 102, 241, 0.4); transform: translateY(-2px); }
.btn-hero.secondary {
  background: rgba(255,255,255,0.04); color: var(--text-primary);
  border: 1px solid rgba(255,255,255,0.08);
}
.btn-hero.secondary:hover { background: rgba(255,255,255,0.08); transform: translateY(-2px); }

/* ── Sections ────────────────────────────────────── */
section { padding: 100px 0; }
.section-label {
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 16px;
}
.section-title {
  font-size: clamp(1.8rem, 4vw, 2.6rem); font-weight: 700; letter-spacing: -0.03em;
  margin-bottom: 16px; line-height: 1.15;
}
.section-desc {
  font-size: 1.05rem; color: var(--text-secondary); max-width: 560px; line-height: 1.7;
}
.section-header { text-align: center; margin-bottom: 64px; }
.section-header .section-desc { margin: 0 auto; }

/* ── Feature Grid ────────────────────────────────── */
.features-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.feature-card {
  background: var(--bg-card); border: 1px solid var(--border-card);
  border-radius: var(--radius); padding: 32px 28px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  transition: all 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.feature-card:hover {
  border-color: var(--border-card-hover);
  transform: translateY(-4px);
  box-shadow: 0 8px 40px rgba(99, 102, 241, 0.08);
}
.feature-icon {
  width: 44px; height: 44px; border-radius: 12px;
  background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.15);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 20px; font-size: 1.2rem;
}
.feature-icon .icon-inner {
  width: 20px; height: 20px; position: relative;
}
.feature-icon .icon-inner::before, .feature-icon .icon-inner::after {
  content: ''; position: absolute; border-radius: 50%;
}
.feature-icon .icon-inner::before {
  width: 10px; height: 10px; background: var(--accent);
  top: 50%; left: 50%; transform: translate(-50%, -50%);
}
.feature-icon .icon-inner::after {
  width: 20px; height: 20px; border: 2px solid var(--accent-purple);
  top: 0; left: 0; opacity: 0.5;
}
.feature-card h3 { font-size: 1.05rem; font-weight: 600; margin-bottom: 10px; }
.feature-card p { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.65; }

/* ── Deploy ──────────────────────────────────────── */
.deploy-section { background: var(--bg-secondary); }
.deploy-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: start; }
.steps { display: flex; flex-direction: column; gap: 24px; }
.step {
  display: flex; gap: 20px; align-items: flex-start;
}
.step-number {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 12px;
  background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.15);
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 700; color: #a5b4fc;
}
.step-content h4 { font-size: 0.95rem; font-weight: 600; margin-bottom: 4px; }
.step-content p { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.6; }
.code-block {
  background: #0d0d14; border: 1px solid rgba(99, 102, 241, 0.1);
  border-radius: var(--radius); overflow: hidden;
}
.code-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 20px; background: rgba(99, 102, 241, 0.04);
  border-bottom: 1px solid rgba(99, 102, 241, 0.08);
  font-size: 0.75rem; color: var(--text-muted);
}
.code-dot { width: 10px; height: 10px; border-radius: 50%; }
.code-dot.r { background: #ff5f57; }
.code-dot.y { background: #febc2e; }
.code-dot.g { background: #28c840; }
.code-header span { margin-left: 8px; }
.code-body {
  padding: 20px; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.8rem; line-height: 1.8; color: #c4c4d4; overflow-x: auto;
}
.code-body .key { color: #818cf8; }
.code-body .str { color: #34d399; }
.code-body .comment { color: #5a5a6e; }

/* ── Architecture ────────────────────────────────── */
.arch-diagram {
  background: #0d0d14; border: 1px solid rgba(99, 102, 241, 0.1);
  border-radius: var(--radius); padding: 40px; overflow-x: auto;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.78rem; line-height: 1.7; color: #9898a6;
  text-align: center; white-space: pre;
}
.arch-diagram .accent { color: #818cf8; }
.arch-diagram .green { color: #34d399; }
.arch-diagram .purple { color: #a78bfa; }
.arch-diagram .yellow { color: #fbbf24; }
.arch-diagram .dim { color: #5a5a6e; }

/* ── Footer ──────────────────────────────────────── */
footer {
  border-top: 1px solid rgba(255,255,255,0.05);
  padding: 48px 0;
}
.footer-inner {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 16px;
}
.footer-inner p { font-size: 0.85rem; color: var(--text-muted); }
.footer-inner a { color: var(--text-secondary); transition: color 0.2s; }
.footer-inner a:hover { color: var(--text-primary); }
.footer-links { display: flex; gap: 24px; }

/* ── Fade-in Animation ───────────────────────────── */
.fade-in {
  opacity: 0; transform: translateY(30px);
  transition: opacity 0.7s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              transform 0.7s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.fade-in.visible { opacity: 1; transform: translateY(0); }
.fade-in:nth-child(2) { transition-delay: 0.08s; }
.fade-in:nth-child(3) { transition-delay: 0.16s; }
.fade-in:nth-child(4) { transition-delay: 0.24s; }
.fade-in:nth-child(5) { transition-delay: 0.32s; }
.fade-in:nth-child(6) { transition-delay: 0.40s; }

/* ── Responsive ──────────────────────────────────── */
@media (max-width: 900px) {
  .features-grid { grid-template-columns: repeat(2, 1fr); }
  .deploy-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .features-grid { grid-template-columns: 1fr; }
  .nav-links { display: none; }
  .nav-links.open {
    display: flex; flex-direction: column; position: absolute;
    top: 64px; left: 0; right: 0; padding: 20px 24px; gap: 16px;
    background: rgba(10, 10, 15, 0.95); border-bottom: 1px solid rgba(99,102,241,0.08);
    backdrop-filter: blur(20px);
  }
  .mobile-toggle { display: block; }
  .hero { padding: 100px 24px 60px; }
  .hero h1 { font-size: 2rem; }
  .hero-buttons { flex-direction: column; align-items: center; }
  .btn-hero { width: 100%; max-width: 280px; text-align: center; }
  section { padding: 64px 0; }
  .arch-diagram { font-size: 0.6rem; padding: 24px 16px; }
}
</style>
</head>
<body>

<!-- ── Navigation ──────────────────────────────────── -->
<nav>
  <div class="container">
    <a href="#" class="logo">personallog.ai</a>
    <div class="nav-links" id="navLinks">
      <a href="#features">Features</a>
      <a href="#deploy">Deploy</a>
      <a href="#architecture">Architecture</a>
      <a href="https://github.com" target="_blank" rel="noopener">GitHub</a>
      <a href="https://github.com" target="_blank" rel="noopener" class="btn-cta">Fork on GitHub &#8599;</a>
    </div>
    <button class="mobile-toggle" id="mobileToggle" aria-label="Toggle navigation">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>

<!-- ── Hero ─────────────────────────────────────────── -->
<section class="hero" id="hero">
  <div class="hero-bg"></div>
  <div class="hero-mesh"></div>
  <div class="hero-particles" id="particles"></div>
  <div class="hero-content">
    <div class="hero-badge"><span class="dot"></span> Open-source and free forever</div>
    <h1>Your personal AI.<br><span class="gradient-word">Living in your repo.</span></h1>
    <p>Open-source. Free. <span id="typingText"></span><span class="typing-cursor">|</span></p>
    <div class="hero-buttons">
      <a href="#deploy" class="btn-hero primary">Get Started</a>
      <a href="https://github.com" target="_blank" rel="noopener" class="btn-hero secondary">View on GitHub &#8599;</a>
    </div>
  </div>
</section>

<!-- ── Features ─────────────────────────────────────── -->
<section id="features">
  <div class="container">
    <div class="section-header">
      <div class="section-label">Features</div>
      <h2 class="section-title">Everything you need,<br>nothing you don't</h2>
      <p class="section-desc">A personal AI agent that understands your codebase, persists across conversations, and meets you on every platform you use.</p>
    </div>
    <div class="features-grid">
      <div class="feature-card fade-in">
        <div class="feature-icon"><div class="icon-inner"></div></div>
        <h3>The Repo IS the Agent</h3>
        <p>Your agent has first-person awareness of its own codebase. It doesn't search the repo — it lives inside it and understands every file.</p>
      </div>
      <div class="feature-card fade-in">
        <div class="feature-icon"><div class="icon-inner"></div></div>
        <h3>Messenger Interface</h3>
        <p>Chat with your agent like WhatsApp meets ChatGPT. Clean, fast, and familiar. No learning curve, just start typing.</p>
      </div>
      <div class="feature-card fade-in">
        <div class="feature-icon"><div class="icon-inner"></div></div>
        <h3>Multi-Channel</h3>
        <p>Telegram, Discord, WhatsApp, Email — one agent, everywhere. Same memory, same personality, every channel.</p>
      </div>
      <div class="feature-card fade-in">
        <div class="feature-icon"><div class="icon-inner"></div></div>
        <h3>Memory That Persists</h3>
        <p>Remembers everything across all conversations and channels. Facts, preferences, context — your agent never forgets.</p>
      </div>
      <div class="feature-card fade-in">
        <div class="feature-icon"><div class="icon-inner"></div></div>
        <h3>Agent-to-Agent</h3>
        <p>Expose an A2A API for visiting agents via MCP. Your agent can collaborate with other agents in the ecosystem.</p>
      </div>
      <div class="feature-card fade-in">
        <div class="feature-icon"><div class="icon-inner"></div></div>
        <h3>File Browser</h3>
        <p>Browse and discuss your repo files directly in the chat. Your agent reads, understands, and explains your code in context.</p>
      </div>
    </div>
  </div>
</section>

<!-- ── Deploy ───────────────────────────────────────── -->
<section id="deploy" class="deploy-section">
  <div class="container">
    <div class="section-header">
      <div class="section-label">Deploy</div>
      <h2 class="section-title">Fork &amp; Deploy in 60 Seconds</h2>
      <p class="section-desc">No signup walls, no credit cards, no vendor lock-in. Fork the repo, add your key, push. That's it.</p>
    </div>
    <div class="deploy-grid">
      <div class="steps">
        <div class="step fade-in">
          <div class="step-number">1</div>
          <div class="step-content">
            <h4>Fork the repo</h4>
            <p>Head to GitHub and fork the personallog repository to your account. One click.</p>
          </div>
        </div>
        <div class="step fade-in">
          <div class="step-number">2</div>
          <div class="step-content">
            <h4>Add DEEPSEEK_API_KEY</h4>
            <p>Go to your repo Settings > Secrets and add your DeepSeek API key as a repository secret.</p>
          </div>
        </div>
        <div class="step fade-in">
          <div class="step-number">3</div>
          <div class="step-content">
            <h4>Push to trigger deploy</h4>
            <p>The included GitHub Action will automatically build and deploy to Cloudflare Workers.</p>
          </div>
        </div>
        <div class="step fade-in">
          <div class="step-number">4</div>
          <div class="step-content">
            <h4>Your AI is live</h4>
            <p>Visit username.personallog-ai.workers.dev and start chatting with your personal AI agent.</p>
          </div>
        </div>
      </div>
      <div class="code-block fade-in">
        <div class="code-header">
          <span class="code-dot r"></span><span class="code-dot y"></span><span class="code-dot g"></span>
          <span>wrangler.toml</span>
        </div>
        <div class="code-body"><span class="key">name</span> = <span class="str">"personallog"</span>
<span class="key">main</span> = <span class="str">"src/index.ts"</span>
<span class="key">compatibility_date</span> = <span class="str">"2024-12-01"</span>

<span class="comment">#[cloudflare] the workers runtime</span>
<span class="key">account_id</span> = <span class="str">"your-account-id"</span>

<span class="comment">#[ai] deepseek as the default provider</span>
<span class="key">[vars]</span>
<span class="key">LLM_PROVIDER</span> = <span class="str">"deepseek"</span>
<span class="key">LLM_MODEL</span>    = <span class="str">"deepseek-chat"</span>
<span class="key">CHANNELS</span>     = <span class="str">"web,telegram"</span>

<span class="comment">#[secrets] set via dashboard or wrangler</span>
<span class="comment"># DEEPSEEK_API_KEY</span></div>
      </div>
    </div>
  </div>
</section>

<!-- ── Architecture ─────────────────────────────────── -->
<section id="architecture">
  <div class="container">
    <div class="section-header">
      <div class="section-label">Architecture</div>
      <h2 class="section-title">How it works</h2>
      <p class="section-desc">A clean, layered architecture. User request in, intelligent response out. Everything persistent, everything yours.</p>
    </div>
    <div class="arch-diagram fade-in">
<span class="dim">┌─────────────────────────────────────────────────────────────────────┐</span>
<span class="dim">│</span>                          <span class="accent">personallog.ai</span>                          <span class="dim">│</span>
<span class="dim">└─────────────────────────────────────────────────────────────────────┘</span>

      <span class="yellow">User</span>                <span class="yellow">Channels</span>               <span class="green">Worker</span>               <span class="purple">Core</span>
  <span class="dim">┌──────────┐</span>     <span class="dim">┌──────────────────┐</span>     <span class="dim">┌──────────────┐</span>     <span class="dim">┌──────────────────────┐</span>
  <span class="dim">│</span> <span class="dim">&#9758;</span>  <span class="yellow">You</span>    <span class="dim">│</span> <span class="dim">──&#9654;</span> <span class="dim">│</span> <span class="accent">Web</span>  <span class="accent">TG</span>  <span class="accent">DC</span>  <span class="accent">WA</span>  <span class="dim">│</span> <span class="dim">──&#9654;</span> <span class="dim">│</span> <span class="green">CF Worker</span>    <span class="dim">│</span> <span class="dim">──&#9654;</span> <span class="dim">│</span> <span class="purple">Agent Core</span>           <span class="dim">│</span>
  <span class="dim">└──────────┘</span>     <span class="dim">└──────────────────┘</span>     <span class="dim">│</span>              <span class="dim">│</span>     <span class="dim">│</span>                      <span class="dim">│</span>
                                               <span class="dim">│</span> <span class="green">Router</span>       <span class="dim">│</span>     <span class="dim">│</span>  <span class="dim">┌──────┐</span>  <span class="dim">┌──────┐</span> <span class="dim">│</span>
                                               <span class="dim">│</span> <span class="green">Auth</span>         <span class="dim">│</span>     <span class="dim">│</span>  <span class="dim">│</span><span class="purple">Soul</span> <span class="dim">│</span>  <span class="dim">│</span><span class="purple">Mem</span>  <span class="dim">│</span> <span class="dim">│</span>
                                               <span class="dim">│</span> <span class="green">Session</span>      <span class="dim">│</span>     <span class="dim">│</span>  <span class="dim">└──────┘</span>  <span class="dim">└──────┘</span> <span class="dim">│</span>
                                               <span class="dim">│</span> <span class="green">Rate Limit</span>   <span class="dim">│</span>     <span class="dim">│</span>  <span class="dim">┌──────┐</span>  <span class="dim">┌──────┐</span> <span class="dim">│</span>
                                               <span class="dim">└──────────────┘</span>     <span class="dim">│</span>  <span class="dim">│</span><span class="purple">Git</span>  <span class="dim">│</span>  <span class="dim">│</span><span class="purple">LLM</span>  <span class="dim">│</span> <span class="dim">│</span>
                                                                    <span class="dim">│</span>  <span class="dim">└──────┘</span>  <span class="dim">└──────┘</span> <span class="dim">│</span>
                                                                    <span class="dim">└──────────────────────┘</span>

  <span class="accent">Web</span> = Web Chat     <span class="accent">TG</span> = Telegram     <span class="accent">DC</span> = Discord
  <span class="accent">WA</span> = WhatsApp      <span class="purple">Soul</span> = soul.md     <span class="purple">Mem</span> = KV Memory
  <span class="purple">Git</span> = Repo Access   <span class="purple">LLM</span> = DeepSeek / OpenAI / Ollama</div>
  </div>
</section>

<!-- ── Footer ───────────────────────────────────────── -->
<footer>
  <div class="container">
    <div class="footer-inner">
      <p>Built with the <a href="https://github.com" target="_blank" rel="noopener">cocapn paradigm</a>. Licensed under MIT.</p>
      <div class="footer-links">
        <a href="https://github.com" target="_blank" rel="noopener">GitHub</a>
        <a href="#features">Features</a>
        <a href="#deploy">Deploy</a>
      </div>
    </div>
  </div>
</footer>

<!-- ── Scripts ──────────────────────────────────────── -->
<script>
(function () {
  'use strict';

  // -- Smooth scroll for anchor links --
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Close mobile nav if open
        document.getElementById('navLinks').classList.remove('open');
      }
    });
  });

  // -- Mobile nav toggle --
  document.getElementById('mobileToggle').addEventListener('click', function () {
    document.getElementById('navLinks').classList.toggle('open');
  });

  // -- Intersection Observer for fade-in --
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.fade-in').forEach(function (el) {
    observer.observe(el);
  });

  // -- Generate floating particles --
  var container = document.getElementById('particles');
  if (container) {
    for (var i = 0; i < 30; i++) {
      var p = document.createElement('div');
      p.className = 'particle';
      var size = Math.max(2, Math.random() * 4);
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = (Math.random() * 100) + '%';
      p.style.top = (60 + Math.random() * 40) + '%';
      p.style.animationDuration = (12 + Math.random() * 20) + 's';
      p.style.animationDelay = (Math.random() * 15) + 's';
      p.style.opacity = '0';
      container.appendChild(p);
    }
  }

  // -- Nav background on scroll --
  var nav = document.querySelector('nav');
  var scrolled = false;
  window.addEventListener('scroll', function () {
    if (!scrolled && window.scrollY > 40) {
      nav.style.borderBottomColor = 'rgba(99, 102, 241, 0.12)';
      scrolled = true;
    } else if (scrolled && window.scrollY <= 40) {
      nav.style.borderBottomColor = 'rgba(99, 102, 241, 0.08)';
      scrolled = false;
    }
  });

  // -- Typing animation --
  (function() {
    var phrases = [
      'Deploys in 60 seconds on Cloudflare Workers.',
      'Remembers every conversation, forever.',
      'One agent. Every channel. Telegram, Discord, WhatsApp.',
      'The repo IS the agent. Fork it, it\\'s yours.',
      'Persistent memory. File browser. A2A protocol.',
      'Zero cost. 100k requests/day free tier.'
    ];
    var el = document.getElementById('typingText');
    if (!el) return;
    var phraseIndex = 0;
    var charIndex = 0;
    var deleting = false;
    var delay = 80;

    function type() {
      var current = phrases[phraseIndex];
      if (deleting) {
        el.textContent = current.substring(0, charIndex - 1);
        charIndex--;
        delay = 40;
      } else {
        el.textContent = current.substring(0, charIndex + 1);
        charIndex++;
        delay = 80;
      }
      if (!deleting && charIndex === current.length) {
        delay = 2500;
        deleting = true;
      } else if (deleting && charIndex === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % phrases.length;
        delay = 300;
      }
      setTimeout(type, delay);
    }
    type();
  })();
})();
</script>
</body>
</html>`;

const FALLBACK_APP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>personallog.ai — Chat</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f0f17;--sidebar:#12121c;--card:#1a1a2e;--card-hover:#222240;
  --text:#e2e8f0;--text-dim:#8892a4;--accent:#6366f1;--accent-hover:#818cf8;
  --border:#1e1e36;--danger:#ef4444;--success:#22c55e;
  --radius:10px;--radius-sm:6px;
}
html,body{height:100%;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;background:var(--bg);color:var(--text)}

/* Layout */
.app{display:flex;height:100vh;width:100vw}

/* Sidebar */
.sidebar{width:280px;min-width:280px;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;transition:transform .3s ease}
.sidebar-header{padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
.agent-avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#8b5cf6);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0}
.agent-info{flex:1;min-width:0}
.agent-name{font-weight:600;font-size:14px}
.agent-status{font-size:12px;color:var(--success);display:flex;align-items:center;gap:4px}
.agent-status::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--success);display:inline-block}
.sidebar-search{padding:12px;border-bottom:1px solid var(--border)}
.sidebar-search input{width:100%;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:13px;outline:none;transition:border-color .2s}
.sidebar-search input:focus{border-color:var(--accent)}
.conv-list{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.conv-item{padding:12px 16px;cursor:pointer;border-left:3px solid transparent;transition:all .15s;display:flex;gap:10px;align-items:flex-start}
.conv-item:hover{background:var(--card)}
.conv-item.active{background:var(--card);border-left-color:var(--accent)}
.conv-title{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.conv-preview{font-size:12px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;margin-top:2px}
.conv-meta{margin-left:auto;text-align:right;flex-shrink:0}
.conv-time{font-size:11px;color:var(--text-dim)}
.sidebar-footer{padding:12px;border-top:1px solid var(--border)}
.new-chat-btn{width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;transition:background .2s}
.new-chat-btn:hover{background:var(--accent-hover)}

/* Chat Panel */
.chat-panel{flex:1;display:flex;flex-direction:column;min-width:0}
.chat-header{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--sidebar)}
.chat-header-title{font-weight:600;font-size:15px;flex:1}
.channel-badge{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--card);color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px}
.header-actions{display:flex;gap:8px}
.icon-btn{width:34px;height:34px;border-radius:var(--radius-sm);background:var(--card);border:1px solid var(--border);color:var(--text-dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;font-size:16px}
.icon-btn:hover{background:var(--card-hover);color:var(--text)}
.icon-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.mobile-menu-btn{display:none}

/* Messages */
.messages{flex:1;overflow-y:auto;padding:20px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.msg-group{margin-bottom:16px;max-width:75%;animation:fadeIn .3s ease}
.msg-group.user{margin-left:auto}
.msg-group.agent{margin-right:auto}
.msg-bubble{padding:12px 16px;border-radius:var(--radius);line-height:1.6;font-size:14px;word-wrap:break-word}
.msg-group.user .msg-bubble{background:var(--accent);color:#fff;border-bottom-right-radius:4px}
.msg-group.agent .msg-bubble{background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px}
.msg-bubble pre{background:#0a0a12;padding:12px;border-radius:var(--radius-sm);overflow-x:auto;margin:8px 0;font-size:13px}
.msg-bubble code{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:13px}
.msg-bubble code:not(pre code){background:rgba(255,255,255,.1);padding:1px 4px;border-radius:3px}
.msg-bubble a{color:var(--accent-hover);text-decoration:underline}
.msg-bubble ul,.msg-bubble ol{padding-left:20px;margin:8px 0}
.msg-bubble li{margin:4px 0}
.msg-time{font-size:11px;color:var(--text-dim);margin-top:4px}
.msg-group.user .msg-time{text-align:right}
.copy-btn{display:inline-block;margin-left:8px;padding:2px 8px;font-size:11px;background:rgba(255,255,255,.1);border:none;border-radius:3px;color:var(--text-dim);cursor:pointer}
.copy-btn:hover{background:rgba(255,255,255,.2)}

/* Typing indicator */
.typing{display:flex;gap:4px;padding:12px 16px}
.typing span{width:8px;height:8px;border-radius:50%;background:var(--text-dim);animation:bounce 1.4s infinite ease-in-out both}
.typing span:nth-child(1){animation-delay:-.32s}
.typing span:nth-child(2){animation-delay:-.16s}

/* Input Bar */
.input-bar{padding:16px 20px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:flex-end;background:var(--sidebar)}
.input-bar textarea{flex:1;resize:none;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:10px 14px;font-size:14px;font-family:inherit;line-height:1.5;max-height:120px;outline:none;transition:border-color .2s}
.input-bar textarea:focus{border-color:var(--accent)}
.send-btn{width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s;flex-shrink:0}
.send-btn:hover{background:var(--accent-hover)}
.send-btn:disabled{opacity:.5;cursor:not-allowed}
.attach-btn{width:40px;height:40px;border-radius:50%;background:var(--card);color:var(--text-dim);border:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
.attach-btn:hover{background:var(--card-hover);color:var(--text)}

/* File Panel */
.file-panel{width:320px;min-width:320px;background:var(--sidebar);border-left:1px solid var(--border);display:flex;flex-direction:column;transition:transform .3s ease,opacity .3s ease}
.file-panel.hidden{display:none}
.file-header{padding:14px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.file-tree{flex:1;overflow-y:auto;padding:8px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.tree-item{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;color:var(--text-dim);transition:all .15s;user-select:none}
.tree-item:hover{background:var(--card);color:var(--text)}
.tree-item.folder{color:var(--text)}
.tree-item .icon{font-size:14px;width:16px;text-align:center;flex-shrink:0}
.tree-children{padding-left:16px;overflow:hidden}
.tree-children.collapsed{display:none}
.file-viewer{border-top:1px solid var(--border);flex-shrink:0;max-height:50%}
.file-viewer-header{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-dim)}
.file-viewer-content{padding:12px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px;line-height:1.6;overflow:auto;max-height:300px;white-space:pre-wrap;word-wrap:break-word;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.discuss-btn{padding:4px 10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);font-size:11px;cursor:pointer;font-weight:500}
.discuss-btn:hover{background:var(--accent-hover)}

/* Login Modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000;animation:fadeIn .2s ease}
.modal{background:var(--sidebar);border:1px solid var(--border);border-radius:var(--radius);padding:32px;width:360px;max-width:90vw}
.modal h2{margin-bottom:8px;font-size:20px}
.modal p{color:var(--text-dim);font-size:14px;margin-bottom:20px}
.modal input{width:100%;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:14px;margin-bottom:12px;outline:none}
.modal input:focus{border-color:var(--accent)}
.modal button{width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);font-size:14px;font-weight:600;cursor:pointer}
.modal button:hover{background:var(--accent-hover)}
.modal-error{color:var(--danger);font-size:13px;margin-bottom:12px;display:none}

/* Animations */
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}

/* Mobile */
@media(max-width:1024px){
  .file-panel{display:none}
  .file-panel.show-mobile{display:flex;position:fixed;right:0;top:0;bottom:0;z-index:100;width:100%;max-width:320px}
}
@media(max-width:768px){
  .sidebar{position:fixed;left:0;top:0;bottom:0;z-index:200;transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .mobile-menu-btn{display:flex}
  .msg-group{max-width:90%}
}
</style>
</head>
<body>

<!-- Login Modal -->
<div class="modal-overlay" id="loginModal" style="display:none">
  <div class="modal">
    <h2>Welcome back</h2>
    <p>Enter your password to access personallog.</p>
    <div class="modal-error" id="loginError">Invalid password</div>
    <input type="password" id="loginInput" placeholder="Password" autofocus>
    <button onclick="doLogin()">Sign in</button>
  </div>
</div>

<div class="app">
  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="agent-avatar">P</div>
      <div class="agent-info">
        <div class="agent-name">Personallog</div>
        <div class="agent-status">Online</div>
      </div>
    </div>
    <div class="sidebar-search">
      <input type="text" id="searchInput" placeholder="Search conversations..." oninput="filterConversations()">
    </div>
    <div class="conv-list" id="convList"></div>
    <div class="sidebar-footer">
      <button class="new-chat-btn" onclick="newConversation()">+ New Chat</button>
    </div>
  </aside>

  <!-- Chat Panel -->
  <main class="chat-panel">
    <div class="chat-header">
      <button class="icon-btn mobile-menu-btn" onclick="toggleSidebar()">&#9776;</button>
      <span class="chat-header-title" id="chatTitle">New Conversation</span>
      <span class="channel-badge" id="channelBadge">web</span>
      <div class="header-actions">
        <button class="icon-btn" id="fileToggleBtn" onclick="toggleFilePanel()" title="File browser">&#128193;</button>
      </div>
    </div>
    <div class="messages" id="messagesContainer"></div>
    <div class="input-bar">
      <button class="attach-btn" title="Attach file">&#128206;</button>
      <textarea id="messageInput" rows="1" placeholder="Type a message..." onkeydown="handleKeyDown(event)" oninput="autoResize(this)"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send">&#10148;</button>
    </div>
  </main>

  <!-- File Panel -->
  <aside class="file-panel hidden" id="filePanel">
    <div class="file-header">
      <span>Files</span>
      <button class="icon-btn" onclick="toggleFilePanel()" style="width:28px;height:28px;font-size:12px">&times;</button>
    </div>
    <div class="file-tree" id="fileTree">
      <div style="padding:20px;text-align:center;color:var(--text-dim);font-size:13px">Loading files...</div>
    </div>
    <div class="file-viewer" id="fileViewer" style="display:none">
      <div class="file-viewer-header">
        <span id="viewerPath">-</span>
        <button class="discuss-btn" onclick="discussFile()">Discuss</button>
      </div>
      <div class="file-viewer-content" id="viewerContent"></div>
    </div>
  </aside>
</div>

<script>
// State
const state = {
  conversations: [],
  activeConvId: null,
  authToken: localStorage.getItem('personallog_token') || '',
  streaming: false,
  currentFile: null,
};

const API = '';  // Same origin

// Init
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  if (state.authToken) {
    loadConversations();
    loadFiles();
  }
  document.getElementById('messageInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); newConversation(); }
    if (e.key === 'Escape') closeFilePanel();
  });
});

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (state.authToken) h['Authorization'] = 'Bearer ' + state.authToken;
  return h;
}

// Auth
async function checkAuth() {
  try {
    const res = await fetch(API + '/api/status', { headers: headers() });
    if (res.status === 401) showLogin();
  } catch { /* might not have auth */ }
}

function showLogin() {
  document.getElementById('loginModal').style.display = 'flex';
}

function doLogin() {
  const pw = document.getElementById('loginInput').value;
  state.authToken = btoa(pw);
  localStorage.setItem('personallog_token', state.authToken);
  document.getElementById('loginModal').style.display = 'none';
  loadConversations();
  loadFiles();
}

// Conversations
async function loadConversations() {
  try {
    const res = await fetch(API + '/api/status', { headers: headers() });
    if (res.ok) {
      // Build conversations from KV — for now, create default
      if (state.conversations.length === 0) {
        newConversation();
      }
    }
  } catch { /* offline */ }
}

function newConversation() {
  const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const conv = {
    id,
    title: 'New Conversation',
    updated: Date.now(),
    messages: [],
    channel: 'web',
  };
  state.conversations.unshift(conv);
  state.activeConvId = id;
  renderConversations();
  clearMessages();
  document.getElementById('chatTitle').textContent = 'New Conversation';
  document.getElementById('channelBadge').textContent = 'web';
  document.getElementById('messageInput').focus();
  closeSidebar();
}

function switchConversation(id) {
  state.activeConvId = id;
  const conv = state.conversations.find(c => c.id === id);
  if (conv) {
    document.getElementById('chatTitle').textContent = conv.title;
    document.getElementById('channelBadge').textContent = conv.channel;
    renderMessages(conv.messages);
  }
  renderConversations();
  closeSidebar();
}

function renderConversations() {
  const list = document.getElementById('convList');
  const search = document.getElementById('searchInput').value.toLowerCase();
  const filtered = state.conversations.filter(c =>
    c.title.toLowerCase().includes(search)
  );
  list.innerHTML = filtered.map(c => {
    const lastMsg = c.messages[c.messages.length - 1];
    const preview = lastMsg ? lastMsg.content.slice(0, 50) : 'No messages yet';
    const time = formatTime(c.updated);
    return '<div class="conv-item ' + (c.id === state.activeConvId ? 'active' : '') + '" onclick="switchConversation(\\'' + c.id + '\\')">' +
      '<div style="flex:1;min-width:0">' +
        '<div class="conv-title">' + esc(c.title) + '</div>' +
        '<div class="conv-preview">' + esc(preview) + '</div>' +
      '</div>' +
      '<div class="conv-meta">' +
        '<div class="conv-time">' + time + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function filterConversations() { renderConversations(); }

// Messages
function renderMessages(messages) {
  const container = document.getElementById('messagesContainer');
  if (!messages.length) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;font-size:14px">Start a conversation with your agent. Ask anything.</div>';
    return;
  }
  container.innerHTML = messages.map(m => renderMessage(m)).join('');
  scrollToBottom();
}

function renderMessage(m) {
  const isUser = m.role === 'user';
  const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const html = isUser ? esc(m.content) : renderMarkdown(m.content);
  return '<div class="msg-group ' + (isUser ? 'user' : 'agent') + '">' +
    '<div class="msg-bubble">' + html + '</div>' +
    '<div class="msg-time">' + time + '</div>' +
  '</div>';
}

function appendMessage(role, content) {
  const conv = state.conversations.find(c => c.id === state.activeConvId);
  if (!conv) return;
  const msg = { role, content, timestamp: Date.now() };
  conv.messages.push(msg);
  if (conv.messages.length === 1 && role === 'user') {
    conv.title = content.slice(0, 60);
    document.getElementById('chatTitle').textContent = conv.title;
    renderConversations();
  }
  const container = document.getElementById('messagesContainer');
  container.insertAdjacentHTML('beforeend', renderMessage(msg));
  scrollToBottom();
}

function showTyping() {
  const container = document.getElementById('messagesContainer');
  container.insertAdjacentHTML('beforeend',
    '<div class="msg-group agent" id="typingIndicator">' +
      '<div class="typing"><span></span><span></span><span></span></div>' +
    '</div>');
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function clearMessages() {
  document.getElementById('messagesContainer').innerHTML =
    '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;font-size:14px">Start a conversation with your agent. Ask anything.</div>';
}

// Send
async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || state.streaming) return;

  input.value = '';
  autoResize(input);
  appendMessage('user', text);
  state.streaming = true;
  document.getElementById('sendBtn').disabled = true;
  showTyping();

  const convId = state.activeConvId;

  try {
    const res = await fetch(API + '/api/chat', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: text, conversationId: convId }),
    });

    hideTyping();

    if (!res.ok) {
      const err = await res.text();
      appendMessage('assistant', 'Error: ' + res.status + ' — ' + err);
      state.streaming = false;
      document.getElementById('sendBtn').disabled = false;
      return;
    }

    // Check if SSE stream
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('text/event-stream')) {
      await readSSEStream(res, convId);
    } else {
      const data = await res.json();
      const content = data.content || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || JSON.stringify(data);
      appendMessage('assistant', content);
    }
  } catch (err) {
    hideTyping();
    appendMessage('assistant', 'Connection error: ' + err.message);
  }

  state.streaming = false;
  document.getElementById('sendBtn').disabled = false;
}

async function readSSEStream(res, convId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let buffer = '';

  // Create placeholder
  const container = document.getElementById('messagesContainer');
  const msgId = 'stream_' + Date.now();
  container.insertAdjacentHTML('beforeend',
    '<div class="msg-group agent" id="' + msgId + '">' +
      '<div class="msg-bubble"></div>' +
      '<div class="msg-time"></div>' +
    '</div>');
  const bubble = document.querySelector('#' + msgId + ' .msg-bubble');

  while (true) {
    const result = await reader.read();
    if (result.done) break;

    buffer += decoder.decode(result.value, { stream: true });
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          content += '\\n\\n**Error:** ' + (parsed.error.message || parsed.error);
          break;
        }
        if (parsed.content) {
          content += parsed.content;
        }
      } catch { /* ignore */ }
    }

    bubble.innerHTML = renderMarkdown(content);
    scrollToBottom();
  }

  // Save to state
  const conv = state.conversations.find(c => c.id === convId);
  if (conv) {
    conv.messages.push({ role: 'assistant', content, timestamp: Date.now() });
  }
}

// File browser
async function loadFiles() {
  try {
    const res = await fetch(API + '/api/files', { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    const files = data.files || [];
    renderFileTree(files);
  } catch { /* offline */ }
}

function renderFileTree(files) {
  const tree = document.getElementById('fileTree');
  if (!files.length) {
    tree.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:13px">No files found. Connect a GitHub repo or upload files via chat.</div>';
    return;
  }
  // Group by directory
  const structure = {};
  for (const f of files) {
    const parts = (f.path || f.name).split('/');
    let node = structure;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = f;
  }
  tree.innerHTML = renderTreeLevel(structure, 0);
}

function renderTreeLevel(node, depth) {
  let html = '';
  const entries = Object.entries(node).sort(function(a, b) {
    const aIsDir = typeof a[1] === 'object' && !a[1].path;
    const bIsDir = typeof b[1] === 'object' && !b[1].path;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  for (const entry of entries) {
    var name = entry[0], val = entry[1];
    const isDir = typeof val === 'object' && !val.path;
    const icon = isDir ? '&#128193;' : '&#128196;';
    const path = isDir ? '' : (val.path || name);
    if (isDir) {
      const id = 'tree_' + name.replace(/[^a-zA-Z0-9]/g, '_');
      html += '<div class="tree-item folder" onclick="toggleFolder(\\'' + id + '\\')">' +
        '<span class="icon">' + icon + '</span> ' + esc(name) +
      '</div>' +
      '<div class="tree-children collapsed" id="' + id + '">' +
        renderTreeLevel(val, depth + 1) +
      '</div>';
    } else {
      html += '<div class="tree-item" onclick="openFile(\\'' + esc(path) + '\\')">' +
        '<span class="icon">' + icon + '</span> ' + esc(name) +
      '</div>';
    }
  }
  return html;
}

function toggleFolder(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsed');
}

async function openFile(path) {
  state.currentFile = path;
  try {
    const res = await fetch(API + '/api/files/' + encodeURIComponent(path), { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    const viewer = document.getElementById('fileViewer');
    viewer.style.display = 'block';
    document.getElementById('viewerPath').textContent = path;
    document.getElementById('viewerContent').textContent = data.content || '';
  } catch { /* ignore */ }
}

function discussFile() {
  if (!state.currentFile) return;
  const input = document.getElementById('messageInput');
  input.value = 'Tell me about the file: ' + state.currentFile;
  sendMessage();
}

function toggleFilePanel() {
  const panel = document.getElementById('filePanel');
  const btn = document.getElementById('fileToggleBtn');
  panel.classList.toggle('hidden');
  btn.classList.toggle('active');
}

function closeFilePanel() {
  document.getElementById('filePanel').classList.add('hidden');
  document.getElementById('fileToggleBtn').classList.remove('active');
}

// Sidebar toggle (mobile)
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
}

// Utilities
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = esc(text);
  // Code blocks
  html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
    return '<pre><code>' + code + '</code></pre>';
  });
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
  // Line breaks
  html = html.replace(/\\n/g, '<br>');
  return html;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function scrollToBottom() {
  const container = document.getElementById('messagesContainer');
  container.scrollTop = container.scrollHeight;
}
</script>
</body>
</html>`;

// ─── Page Handlers ──────────────────────────────────────────────────────────────

async function handleLandingPage(env: Env): Promise<Response> {
  const custom = await env.FILES.get('landing-page');
  return htmlResponse(custom || FALLBACK_LANDING);
}

async function handleAppPage(request: Request, env: Env): Promise<Response> {
  if (!isAuthenticated(request, env) && env.OWNER_PASSWORD) {
    return Response.redirect(new URL(request.url).origin + '/', 302);
  }
  const custom = await env.FILES.get('app-page');
  return htmlResponse(custom || FALLBACK_APP);
}

// ─── Chat Handler ───────────────────────────────────────────────────────────────

async function handleChat(request: Request, env: Env): Promise<Response> {
  const authError = requireAuth(request, env);
  if (authError) return authError;

  let body: { message?: string; messages?: ChatMessage[]; conversationId?: string; stream?: boolean };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const userMessage = body.message;
  const providedMessages = body.messages;
  const conversationId = body.conversationId || crypto.randomUUID();
  const wantStream = body.stream !== false;

  if (!userMessage && (!providedMessages || providedMessages.length === 0)) {
    return errorResponse('Provide "message" (string) or "messages" (array)', 400);
  }

  // Build message array
  const systemPrompt = await buildSystemPrompt(env);
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  // Load conversation history from MEMORY KV
  if (conversationId) {
    const history = await env.MEMORY.get<ConversationRecord>(`conversation:${conversationId}`, 'json');
    if (history?.messages) {
      for (const msg of history.messages.slice(-(MAX_CONVERSATION_MESSAGES - 2))) {
        messages.push(msg);
      }
    }
  }

  // Add user-provided messages
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  } else if (providedMessages) {
    for (const msg of providedMessages) {
      if (msg.role !== 'system') {
        messages.push(msg);
      }
    }
  }

  if (!env.DEEPSEEK_API_KEY) {
    return errorResponse('DEEPSEEK_API_KEY is not configured', 503);
  }

  // Record usage
  await recordEvent(env, 'chat', { conversationId, messageCount: messages.length });

  if (wantStream) {
    return streamChat(messages, conversationId, env);
  }

  // Non-streaming fallback
  const response = await fetch(DEEPSEEK_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      max_tokens: MAX_SSE_TOKENS,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return errorResponse(`DeepSeek API error: ${response.status} ${errText}`, 502);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const assistantContent = data.choices?.[0]?.message?.content;
  if (!assistantContent) {
    return errorResponse('DeepSeek returned no content', 502);
  }

  // Save to conversation history
  await saveConversationTurn(env, conversationId, userMessage || '', assistantContent);

  return jsonResponse({
    content: assistantContent,
    conversationId,
    usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
  });
}

function streamChat(messages: ChatMessage[], conversationId: string, env: Env): Response {
  const encoder = new TextEncoder();
  let fullContent = '';
  let lastUserMessage = '';

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMessage = messages[i].content;
      break;
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await fetch(DEEPSEEK_CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages,
            max_tokens: MAX_SSE_TOKENS,
            temperature: 0.7,
            stream: true,
          }),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          const errorData = JSON.stringify({ error: `DeepSeek API error: ${response.status} ${errText}` });
          controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
          controller.close();
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          controller.enqueue(encoder.encode('data: {"error":"No response body"}\n\n'));
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('data: ')) {
              const payload = trimmed.slice(6);
              if (payload === '[DONE]') {
                // Save conversation after streaming completes
                await saveConversationTurn(env, conversationId, lastUserMessage, fullContent);
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                }
              } catch {
                // Forward malformed chunks as-is
              }

              // Forward the SSE line to the client
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(`${buffer}\n\n`));
        }

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
        } catch {
          // Controller may already be closed
        }
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return withCors(new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  }));
}

async function saveConversationTurn(
  env: Env,
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const key = `conversation:${conversationId}`;
  const existing = await env.MEMORY.get<ConversationRecord>(key, 'json');

  const messages: ChatMessage[] = existing?.messages || [];
  if (userText) messages.push({ role: 'user', content: userText });
  if (assistantText) messages.push({ role: 'assistant', content: assistantText });

  const record: ConversationRecord = {
    id: conversationId,
    messages: messages.slice(-MAX_CONVERSATION_MESSAGES),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await env.MEMORY.put(key, JSON.stringify(record), { expirationTtl: 30 * 24 * 3600 });
}

// ─── Files API ──────────────────────────────────────────────────────────────────

async function handleListFiles(env: Env): Promise<Response> {
  // Prefer GitHub API if configured
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/`,
        {
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'personallog-worker',
          },
        },
      );

      if (response.ok) {
        const contents = await response.json() as Array<{
          name: string; path: string; size: number; type: string;
        }>;
        const files: FileEntry[] = contents
          .filter((item) => item.type === 'file')
          .map((item) => ({
            path: item.path,
            size: item.size,
            modified: new Date().toISOString(),
          }));
        return jsonResponse({ files, source: 'github' });
      }
    } catch {
      // Fall through to KV
    }
  }

  // Fallback: list FILES KV
  const listed = await env.FILES.list();
  const files: FileEntry[] = listed.keys.map((key) => ({
    path: key.name,
    size: 0,
    modified: key.metadata?.modified as string || new Date().toISOString(),
  }));
  return jsonResponse({ files, source: 'kv' });
}

async function handleReadFile(path: string, env: Env): Promise<Response> {
  if (!path) return errorResponse('Missing file path', 400);

  // Try GitHub first
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
        {
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.raw+json',
            'User-Agent': 'personallog-worker',
          },
        },
      );

      if (response.ok) {
        const content = await response.text();
        return jsonResponse({ path, content, source: 'github' });
      }
    } catch {
      // Fall through to KV
    }
  }

  // Fallback: FILES KV
  const content = await env.FILES.get(path);
  if (content === null) {
    return errorResponse(`File not found: ${path}`, 404);
  }
  return jsonResponse({ path, content, source: 'kv' });
}

async function handleWriteFile(path: string, request: Request, env: Env): Promise<Response> {
  const authError = requireAuth(request, env);
  if (authError) return authError;
  if (!path) return errorResponse('Missing file path', 400);

  let body: { content: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (typeof body.content !== 'string') {
    return errorResponse('Missing or invalid "content" field', 400);
  }

  await env.FILES.put(path, body.content, {
    metadata: { modified: new Date().toISOString(), size: body.content.length },
  });

  await recordEvent(env, 'file-write', { path, size: body.content.length });

  return jsonResponse({ ok: true, path, size: body.content.length });
}

// ─── Status & Analytics ─────────────────────────────────────────────────────────

async function handleStatus(env: Env): Promise<Response> {
  const soulMd = await env.MEMORY.get('soul.md');
  const compiled = soulMd ? soulCompiler.compile(soulMd) : null;

  // Count memory entries
  let memoryCount = 0;
  const memoryList = await env.MEMORY.list();
  memoryCount = memoryList.keys.length;
  // Handle pagination for KV list (max 1000 per page)
  let cursor = memoryList.list_complete ? undefined : memoryList.cursor;
  while (cursor) {
    const nextPage = await env.MEMORY.list({ cursor });
    memoryCount += nextPage.keys.length;
    cursor = nextPage.list_complete ? undefined : nextPage.cursor;
  }

  const status: AgentStatus = {
    ok: true,
    soulLoaded: !!soulMd,
    soulName: compiled?.name || '',
    memoryCount,
    uptime: Math.floor((Date.now() - WORKER_START_TIME) / 1000),
    version: VERSION,
    timestamp: new Date().toISOString(),
  };

  return jsonResponse(status);
}

async function handleAnalytics(request: Request, env: Env): Promise<Response> {
  const authError = requireAuth(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 30);

  const allEvents: Array<{ event: string; ts: string }> = [];
  const now = new Date();

  for (let d = 0; d < days; d++) {
    const date = new Date(now.getTime() - d * 24 * 3600 * 1000);
    const dateStr = date.toISOString().split('T')[0];
    const key = `events:${dateStr}`;
    const raw = await env.ANALYTICS_KV.get(key);
    if (raw) {
      try {
        const dayEvents = JSON.parse(raw) as Array<{ event: string; ts: string }>;
        allEvents.push(...dayEvents);
      } catch {
        // Skip malformed entries
      }
    }
  }

  // Aggregate counts
  const counts: Record<string, number> = {};
  for (const evt of allEvents) {
    counts[evt.event] = (counts[evt.event] || 0) + 1;
  }

  return jsonResponse({
    period: `${days}d`,
    totalEvents: allEvents.length,
    counts,
    events: allEvents.slice(-200),
  });
}

// ─── A2A Handler ────────────────────────────────────────────────────────────────

async function handleA2A(request: Request, env: Env): Promise<Response> {
  let rpcRequest: { jsonrpc?: string; method?: string; id?: string | number | null; params?: unknown };
  try {
    rpcRequest = await request.json() as typeof rpcRequest;
  } catch {
    return jsonResponse({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }

  const { method, id, params } = rpcRequest;

  if (rpcRequest.jsonrpc !== '2.0' || !method) {
    return jsonResponse({
      jsonrpc: '2.0', id: id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    });
  }

  try {
    let result: unknown;

    switch (method) {
      case 'send_task': {
        const p = params as { id?: string; message?: { parts?: Array<{ type: string; text?: string }> } };
        const taskId = p.id || `a2a-${Date.now()}`;
        const userText = p.message?.parts
          ?.filter((pt) => pt.type === 'text')
          .map((pt) => pt.text || '')
          .join(' ') || '';

        const systemPrompt = await buildSystemPrompt(env);
        const chatMessages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ];

        let content: string;
        if (env.DEEPSEEK_API_KEY) {
          const response = await fetch(DEEPSEEK_CHAT_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
              model: DEEPSEEK_MODEL,
              messages: chatMessages,
              max_tokens: MAX_SSE_TOKENS,
              temperature: 0.7,
            }),
          });

          if (!response.ok) {
            content = `[A2A error: DeepSeek returned ${response.status}]`;
          } else {
            const data = await response.json() as {
              choices: Array<{ message: { content: string } }>;
            };
            content = data.choices?.[0]?.message?.content || '[No response]';
          }
        } else {
          content = `[A2A received: "${userText}"] — DEEPSEEK_API_KEY not configured.`;
        }

        await recordEvent(env, 'a2a_task', { taskId });

        result = {
          id: taskId,
          status: { state: 'completed', timestamp: new Date().toISOString() },
          message: {
            role: 'agent',
            parts: [{ type: 'text', text: content }],
          },
        };
        break;
      }

      case 'get_task': {
        const p = params as { id?: string };
        result = {
          id: p.id || 'unknown',
          status: { state: 'completed', timestamp: new Date().toISOString() },
        };
        break;
      }

      case 'cancel_task': {
        const p = params as { id?: string };
        result = {
          id: p.id || 'unknown',
          status: { state: 'canceled', timestamp: new Date().toISOString() },
        };
        break;
      }

      default:
        return jsonResponse({
          jsonrpc: '2.0', id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }

    return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({
      jsonrpc: '2.0', id: id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
  }
}

// ─── MCP Handler ────────────────────────────────────────────────────────────────

async function handleMCP(request: Request, env: Env): Promise<Response> {
  let rpcRequest: { jsonrpc?: string; method?: string; id?: string | number | null; params?: unknown };
  try {
    rpcRequest = await request.json() as typeof rpcRequest;
  } catch {
    return jsonResponse({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }

  const { method, id, params } = rpcRequest;

  if (rpcRequest.jsonrpc !== '2.0' || !method) {
    return jsonResponse({
      jsonrpc: '2.0', id: id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    });
  }

  try {
    let result: unknown;

    switch (method) {
      case 'initialize': {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'personallog-mcp', version: VERSION },
        };
        break;
      }

      case 'tools/list': {
        result = {
          tools: [
            {
              name: 'chat',
              description: 'Chat with the personallog.ai agent',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'The message to send' },
                },
                required: ['message'],
              },
            },
            {
              name: 'read_file',
              description: 'Read a file from the agent\'s storage',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path to read' },
                },
                required: ['path'],
              },
            },
            {
              name: 'list_files',
              description: 'List files in the agent\'s storage',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'get_memory',
              description: 'Retrieve a memory value by key',
              inputSchema: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Memory key' },
                },
                required: ['key'],
              },
            },
          ],
        };
        break;
      }

      case 'tools/call': {
        const p = params as { name?: string; arguments?: Record<string, unknown> };
        const toolName = p.name;
        const args = p.arguments || {};

        switch (toolName) {
          case 'chat': {
            const message = args.message as string;
            if (!message) {
              result = { content: [{ type: 'text', text: 'Missing "message" argument' }], isError: true };
              break;
            }

            if (!env.DEEPSEEK_API_KEY) {
              result = { content: [{ type: 'text', text: 'DEEPSEEK_API_KEY not configured' }], isError: true };
              break;
            }

            const systemPrompt = await buildSystemPrompt(env);
            const response = await fetch(DEEPSEEK_CHAT_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
              },
              body: JSON.stringify({
                model: DEEPSEEK_MODEL,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: message },
                ],
                max_tokens: MAX_SSE_TOKENS,
                temperature: 0.7,
              }),
            });

            if (!response.ok) {
              result = { content: [{ type: 'text', text: `DeepSeek error: ${response.status}` }], isError: true };
            } else {
              const data = await response.json() as {
                choices: Array<{ message: { content: string } }>;
              };
              const text = data.choices?.[0]?.message?.content || '[No response]';
              result = { content: [{ type: 'text', text }] };
            }
            break;
          }

          case 'read_file': {
            const filePath = args.path as string;
            if (!filePath) {
              result = { content: [{ type: 'text', text: 'Missing "path" argument' }], isError: true };
              break;
            }
            const content = await env.FILES.get(filePath);
            if (content === null) {
              result = { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
            } else {
              result = { content: [{ type: 'text', text: content }] };
            }
            break;
          }

          case 'list_files': {
            const listed = await env.FILES.list();
            const paths = listed.keys.map((k) => k.name);
            result = { content: [{ type: 'text', text: JSON.stringify(paths) }] };
            break;
          }

          case 'get_memory': {
            const key = args.key as string;
            if (!key) {
              result = { content: [{ type: 'text', text: 'Missing "key" argument' }], isError: true };
              break;
            }
            const value = await env.MEMORY.get(key);
            result = { content: [{ type: 'text', text: value || '[not found]' }] };
            break;
          }

          default:
            result = { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
        }
        break;
      }

      case 'resources/list': {
        result = { resources: [], resourceTemplates: [] };
        break;
      }

      default:
        return jsonResponse({
          jsonrpc: '2.0', id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }

    await recordEvent(env, 'mcp_call', { method });
    return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({
      jsonrpc: '2.0', id: id ?? null,
      error: { code: -32603, message: `Internal error: ${message}` },
    });
  }
}

// ─── WebSocket Handler ──────────────────────────────────────────────────────────

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return errorResponse('Expected WebSocket upgrade', 400);
  }

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];

  server.accept();

  const connectionId = crypto.randomUUID();
  server.addEventListener('message', async (event) => {
    let data: { type?: string; message?: string; conversationId?: string };
    try {
      data = JSON.parse(event.data as string) as typeof data;
    } catch {
      server.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (data.type === 'ping') {
      server.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (data.type === 'chat' || data.message) {
      const userMessage = data.message || '';
      if (!userMessage.trim()) {
        server.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
        return;
      }

      if (!env.DEEPSEEK_API_KEY) {
        server.send(JSON.stringify({ type: 'error', error: 'DEEPSEEK_API_KEY not configured' }));
        return;
      }

      const conversationId = data.conversationId || connectionId;
      const systemPrompt = await buildSystemPrompt(env);

      // Load history
      const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
      const history = await env.MEMORY.get<ConversationRecord>(`conversation:${conversationId}`, 'json');
      if (history?.messages) {
        messages.push(...history.messages.slice(-(MAX_CONVERSATION_MESSAGES - 2)));
      }
      messages.push({ role: 'user', content: userMessage });

      server.send(JSON.stringify({ type: 'typing', conversationId }));

      try {
        const response = await fetch(DEEPSEEK_CHAT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages,
            max_tokens: MAX_SSE_TOKENS,
            temperature: 0.7,
          }),
        });

        if (!response.ok) {
          server.send(JSON.stringify({ type: 'error', error: `DeepSeek API error: ${response.status}` }));
          return;
        }

        const chatData = await response.json() as {
          choices: Array<{ message: { content: string } }>;
        };
        const content = chatData.choices?.[0]?.message?.content || '[No response]';

        await saveConversationTurn(env, conversationId, userMessage, content);

        server.send(JSON.stringify({
          type: 'chat',
          role: 'assistant',
          content,
          conversationId,
        }));

        await recordEvent(env, 'ws_chat', { conversationId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        server.send(JSON.stringify({ type: 'error', error: message }));
      }
    }
  });

  server.addEventListener('close', () => {
    // Connection cleanup — KV handles TTL-based expiration
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

// ─── Channel Handlers ───────────────────────────────────────────────────────────

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return errorResponse('Telegram bot not configured', 503);
  }

  const authError = requireAuth(request, env);
  if (authError) return authError;

  if (!verifyTelegramAuth(request, env.TELEGRAM_BOT_TOKEN)) {
    return errorResponse('Invalid Telegram authentication', 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const result = await handleTelegramMessage(body, env);
  await recordEvent(env, 'telegram_message');
  return jsonResponse(result);
}

async function handleDiscordWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) {
    return errorResponse('Discord bot not configured', 503);
  }

  const body = await request.text();
  const signature = request.headers.get('X-Signature-Ed25519') || '';
  const timestamp = request.headers.get('X-Signature-Timestamp') || '';

  const verification = await verifyDiscordInteraction(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!verification.valid) {
    return errorResponse('Invalid Discord signature', 401);
  }

  let eventBody: Record<string, unknown>;
  try {
    eventBody = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const result = await handleDiscordEvent(eventBody, env);
  await recordEvent(env, 'discord_event', { type: eventBody.type as string });
  return jsonResponse(result);
}

async function handleWhatsAppWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.WHATSAPP_VERIFY_TOKEN || !env.WHATSAPP_ACCESS_TOKEN) {
    return errorResponse('WhatsApp not configured', 503);
  }

  const url = new URL(request.url);

  // Webhook verification (GET)
  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && verifyWhatsAppWebhook(token, env.WHATSAPP_VERIFY_TOKEN)) {
      return new Response(challenge, { status: 200 });
    }
    return errorResponse('Verification failed', 403);
  }

  // Event handling (POST)
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const result = await handleWhatsAppEvent(body, env);
  await recordEvent(env, 'whatsapp_event');
  return jsonResponse(result);
}

// ─── Main Router ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      // ── Pages ──────────────────────────────────────────────────────────────

      if (pathname === '/' && method === 'GET') {
        return handleLandingPage(env);
      }

      if (pathname === '/app' && method === 'GET') {
        return handleAppPage(request, env);
      }

      // ── Chat ───────────────────────────────────────────────────────────────

      if (pathname === '/api/chat' && method === 'POST') {
        return handleChat(request, env);
      }

      // ── Files ──────────────────────────────────────────────────────────────

      if (pathname === '/api/files' && method === 'GET') {
        return handleListFiles(env);
      }

      if (pathname.startsWith('/api/files/') && method === 'GET') {
        const filePath = decodeURIComponent(pathname.slice('/api/files/'.length));
        return handleReadFile(filePath, env);
      }

      if (pathname.startsWith('/api/files/') && method === 'POST') {
        const filePath = decodeURIComponent(pathname.slice('/api/files/'.length));
        return handleWriteFile(filePath, request, env);
      }

      // ── Status & Analytics ─────────────────────────────────────────────────

      if (pathname === '/api/status' && method === 'GET') {
        return handleStatus(env);
      }

      if (pathname === '/api/analytics' && method === 'GET') {
        return handleAnalytics(request, env);
      }

      // ── A2A Protocol ───────────────────────────────────────────────────────

      if (pathname.startsWith('/api/a2a') && method === 'POST') {
        return handleA2A(request, env);
      }

      // ── MCP Protocol ───────────────────────────────────────────────────────

      if (pathname.startsWith('/api/mcp') && method === 'POST') {
        return handleMCP(request, env);
      }

      // ── Channels ───────────────────────────────────────────────────────────

      if (pathname === '/api/channels/telegram' && method === 'POST') {
        return handleTelegramWebhook(request, env);
      }

      if (pathname === '/api/channels/discord' && (method === 'POST' || method === 'GET')) {
        return handleDiscordWebhook(request, env);
      }

      if (pathname === '/api/channels/whatsapp' && (method === 'POST' || method === 'GET')) {
        return handleWhatsAppWebhook(request, env);
      }

      // ── WebSocket ──────────────────────────────────────────────────────────

      if (pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
        return handleWebSocket(request, env);
      }

      // ── Agent Card (A2A discovery) ─────────────────────────────────────────

      if (pathname === '/.well-known/agent.json' && method === 'GET') {
        const origin = url.origin;
        return jsonResponse({
          name: 'personallog-agent',
          description: 'Personal AI agent on personallog.ai',
          url: origin,
          version: VERSION,
          capabilities: {
            streaming: true,
            pushNotifications: false,
            stateTransitionHistory: true,
          },
          skills: [
            {
              id: 'chat',
              name: 'Chat',
              tags: ['conversation', 'reasoning'],
              examples: ['What should I work on today?', 'Summarize my recent activity'],
            },
          ],
        });
      }

      // ── Not Found ──────────────────────────────────────────────────────────

      return errorResponse('Not found', 404);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[personallog] Unhandled error on ${method} ${pathname}:`, message);
      return errorResponse(`Internal server error: ${message}`, 500);
    }
  },
};
