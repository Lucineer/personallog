/**
 * context.ts — Smart context building for the agent
 *
 * Assembles system prompt + memory context + file context
 * into a coherent prompt for the LLM.
 */

import { getSoul, buildSystemPrompt } from './soul.js';
import { getRelevantContext, getConversation, type MemoryMessage } from './memory.js';
import { readFile } from './git.js';

export interface ContextOptions {
  conversationId: string;
  query: string;
  channel?: string;
  fileContext?: string;
}

/** Build the full context for an LLM call */
export async function buildContext(
  memory: KVNamespace,
  files: KVNamespace | undefined,
  githubToken: string | undefined,
  githubRepo: string | undefined,
  options: ContextOptions
): Promise<{ system: string; messages: MemoryMessage[] }> {
  // 1. Load soul
  const soul = await getSoul(memory);

  // 2. Get relevant facts
  const relevantFacts = await getRelevantContext(memory, options.query);

  // 3. Load file context if requested
  let fileContextStr: string[] = [];
  if (options.fileContext) {
    if (files || (githubToken && githubRepo)) {
      const file = await readFile(githubToken, githubRepo, files, options.fileContext);
      if (file) {
        fileContextStr.push(`File: ${file.path}\n\`\`\`\n${file.content.slice(0, 5000)}\n\`\`\``);
      }
    }
  }

  // 4. Build system prompt
  const allContext = [...relevantFacts, ...fileContextStr];
  const system = buildSystemPrompt(soul, allContext);

  // 5. Load conversation history
  const messages = await getConversation(memory, options.conversationId);

  return { system, messages };
}

/** Format messages for the DeepSeek API */
export function formatForLLM(
  system: string,
  history: MemoryMessage[],
  newMessage: string,
  maxHistory: number = 20
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: system },
  ];

  // Add recent history
  const recent = history.slice(-maxHistory);
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add new message
  messages.push({ role: 'user', content: newMessage });

  return messages;
}
