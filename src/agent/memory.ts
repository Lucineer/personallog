/**
 * memory.ts — KV-backed agent memory
 *
 * Stores:
 * - conversations: per-conversation message history
 * - facts: key-value facts about the owner
 * - procedures: learned workflows
 * - meta: metadata (message counts, last active, etc)
 */

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  channel?: string;
}

export interface Fact {
  key: string;
  value: string;
  confidence: number;
  updated: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
  messageCount: number;
  channel: string;
}

const CONVERSATIONS_PREFIX = 'conv:';
const FACTS_PREFIX = 'fact:';
const META_PREFIX = 'meta:';

/** Get messages for a conversation */
export async function getConversation(
  kv: KVNamespace,
  convId: string
): Promise<MemoryMessage[]> {
  const raw = await kv.get(`${CONVERSATIONS_PREFIX}${convId}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as MemoryMessage[];
  } catch {
    return [];
  }
}

/** Append messages to a conversation */
export async function appendMessages(
  kv: KVNamespace,
  convId: string,
  messages: MemoryMessage[],
  channel: string = 'web'
): Promise<void> {
  const existing = await getConversation(kv, convId);
  const updated = [...existing, ...messages];
  // Keep last 100 messages per conversation
  const trimmed = updated.slice(-100);
  await kv.put(`${CONVERSATIONS_PREFIX}${convId}`, JSON.stringify(trimmed));

  // Update conversation meta
  const metaKey = `${META_PREFIX}${convId}`;
  const meta: ConversationMeta = {
    id: convId,
    title: extractTitle(trimmed),
    created: trimmed[0]?.timestamp ?? Date.now(),
    updated: Date.now(),
    messageCount: trimmed.length,
    channel,
  };
  await kv.put(metaKey, JSON.stringify(meta));

  // Update conversation index
  await updateConversationIndex(kv, convId, meta);
}

/** List all conversations */
export async function listConversations(
  kv: KVNamespace
): Promise<ConversationMeta[]> {
  const raw = await kv.get('conv_index');
  if (!raw) return [];
  try {
    const index = JSON.parse(raw) as Record<string, ConversationMeta>;
    return Object.values(index).sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

/** Get a fact */
export async function getFact(kv: KVNamespace, key: string): Promise<string | null> {
  const raw = await kv.get(`${FACTS_PREFIX}${key}`);
  if (!raw) return null;
  try {
    const fact = JSON.parse(raw) as Fact;
    return fact.value;
  } catch {
    return null;
  }
}

/** Set a fact */
export async function setFact(
  kv: KVNamespace,
  key: string,
  value: string,
  confidence: number = 0.9
): Promise<void> {
  const fact: Fact = { key, value, confidence, updated: Date.now() };
  await kv.put(`${FACTS_PREFIX}${key}`, JSON.stringify(fact));
}

/** Get all facts */
export async function getAllFacts(kv: KVNamespace): Promise<Fact[]> {
  const facts: Fact[] = [];
  const list = await kv.list({ prefix: FACTS_PREFIX });
  for (const key of list.keys) {
    const raw = await kv.get(key.name);
    if (raw) {
      try {
        facts.push(JSON.parse(raw) as Fact);
      } catch {
        // skip malformed
      }
    }
  }
  return facts;
}

/** Extract relevant context from memory for a query */
export async function getRelevantContext(
  kv: KVNamespace,
  query: string,
  limit: number = 5
): Promise<string[]> {
  const facts = await getAllFacts(kv);
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 3);

  const scored = facts.map(f => {
    const factLower = `${f.key} ${f.value}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (factLower.includes(word)) score += 1;
    }
    return { fact: f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, limit)
    .filter(s => s.score > 0)
    .map(s => `${s.fact.key}: ${s.fact.value}`);
}

/** Record analytics event */
export async function recordEvent(
  kv: KVNamespace,
  event: string,
  meta?: Record<string, string>
): Promise<void> {
  const date = new Date().toISOString().split('T')[0];
  const key = `analytics:${date}`;
  const raw = await kv.get(key);
  const events = raw ? JSON.parse(raw) : [];
  events.push({ event, meta, ts: Date.now() });
  // Keep last 1000 events per day
  await kv.put(key, JSON.stringify(events.slice(-1000)));
}

/** Get analytics for a date range */
export async function getAnalytics(
  kv: KVNamespace,
  days: number = 7
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown[]> = {};
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().split('T')[0];
    const raw = await kv.get(`analytics:${date}`);
    result[date] = raw ? JSON.parse(raw) : [];
  }
  return result;
}

// --- Internal helpers ---

async function updateConversationIndex(
  kv: KVNamespace,
  convId: string,
  meta: ConversationMeta
): Promise<void> {
  const raw = await kv.get('conv_index');
  const index = raw ? JSON.parse(raw) : {};
  index[convId] = meta;
  // Keep last 100 conversations
  const entries = Object.entries(index) as [string, ConversationMeta][];
  if (entries.length > 100) {
    entries.sort(([, a], [, b]) => a.updated - b.updated);
    const toRemove = entries.slice(0, entries.length - 100);
    for (const [id] of toRemove) {
      delete index[id];
    }
  }
  await kv.put('conv_index', JSON.stringify(index));
}

function extractTitle(messages: MemoryMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return 'New Conversation';
  const content = firstUser.content;
  if (content.length <= 60) return content;
  return content.slice(0, 57) + '...';
}
