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
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>personallog.ai</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#333}
h1{font-size:2rem}a{color:#0066cc}</style>
</head><body>
<h1>personallog.ai</h1>
<p>Your personal AI agent, always online.</p>
<p><a href="/app">Open app</a> (requires authentication)</p>
</body></html>`;

const FALLBACK_APP = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>personallog.ai — App</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;color:#333}
#header{padding:1rem;border-bottom:1px solid #eee;font-weight:bold}
#messages{flex:1;overflow-y:auto;padding:1rem}
.msg{margin-bottom:0.75rem;padding:0.5rem 0.75rem;border-radius:8px;max-width:80%;white-space:pre-wrap;word-break:break-word}
.msg.user{background:#e3f2fd;margin-left:auto;text-align:right}
.msg.assistant{background:#f5f5f5}
#input-area{display:flex;padding:1rem;border-top:1px solid #eee;gap:0.5rem}
#input{flex:1;padding:0.5rem;border:1px solid #ccc;border-radius:4px;font-size:1rem}
#send{padding:0.5rem 1rem;background:#0066cc;color:white;border:none;border-radius:4px;cursor:pointer}
#send:disabled{opacity:0.5;cursor:not-allowed}
</style></head><body>
<div id="header">personallog.ai</div>
<div id="messages"></div>
<div id="input-area">
<input type="text" id="input" placeholder="Type a message..." autofocus>
<button id="send">Send</button>
</div>
<script>
const msgs = document.getElementById('messages');
const input = document.getElementById('input');
const send = document.getElementById('send');
const token = localStorage.getItem('token') || '';

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

send.onclick = async () => {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send.disabled = true;
  addMsg('user', text);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ message: text, stream: true }),
    });
    if (!res.ok) { addMsg('assistant', 'Error: ' + res.statusText); send.disabled = false; return; }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      const el = document.createElement('div');
      el.className = 'msg assistant';
      msgs.appendChild(el);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\\n')) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            if (payload === '[DONE]') break;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              assistantText += delta;
              el.textContent = assistantText;
              msgs.scrollTop = msgs.scrollHeight;
            } catch {}
          }
        }
      }
    } else {
      const data = await res.json();
      addMsg('assistant', data.content || data.error || JSON.stringify(data));
    }
  } catch (e) { addMsg('assistant', 'Connection error: ' + e.message); }
  send.disabled = false;
};
input.onkeydown = (e) => { if (e.key === 'Enter') send.click(); };
</script></body></html>`;

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
