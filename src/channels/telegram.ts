/**
 * channels/telegram.ts — Telegram Bot webhook handler
 *
 * Receives Telegram Update objects via webhook, normalises them into
 * NormalizedMessage, and sends responses back through the Bot API.
 *
 * Env variables used:
 *   TELEGRAM_BOT_TOKEN — Bot token from @BotFather
 */

import { normalizeMessage, type NormalizedMessage } from './normalize.js';
import { corsHeaders, jsonResponse, errorResponse, getEnvVar } from '../utils/index.js';

// ---------------------------------------------------------------------------
// Telegram types
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: Array<{
    offset: number;
    length: number;
    type: string;
  }>;
  reply_to_message?: TelegramMessage;
  forward_from?: TelegramUser;
  forward_date?: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

/** Top-level Update object sent by Telegram to the webhook. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Response returned from the handler for the worker to use. */
export interface TelegramHandlerResult {
  normalized: NormalizedMessage;
  reply: string;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const WELCOME_MESSAGE = [
  'Welcome! I am your PersonalLog AI agent.',
  '',
  'I can help you take notes, manage tasks, search your knowledge base, and more.',
  '',
  'Commands:',
  '/start — Show this welcome message',
  '/help — Display available commands',
].join('\n');

const HELP_MESSAGE = [
  '*Available Commands*',
  '',
  '/start — Welcome message and introduction',
  '/help — This help text',
  '',
  'You can also just send me a message and I\\\'ll respond naturally.',
  'I remember our conversations and learn your preferences over time.',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** POST a text message to the Telegram Bot API sendMessage endpoint. */
async function replyToChat(
  chatId: number,
  text: string,
  botToken: string,
  parseMode: string = 'Markdown',
): Promise<Response> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }),
  });
}

/** Escape special MarkdownV2 characters in a string. */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Extract command name and payload from a message that starts with a bot command entity.
 * Returns null if the message does not contain a command.
 */
function parseCommand(
  text: string,
  entities?: Array<{ offset: number; length: number; type: string }>,
): { command: string; args: string } | null {
  if (!entities) return null;

  const cmdEntity = entities.find((e) => e.type === 'bot_command');
  if (!cmdEntity) return null;

  const command = text.slice(cmdEntity.offset, cmdEntity.offset + cmdEntity.length);
  // Strip leading '/' and any @botname suffix
  const cleanCommand = command.replace(/^\//, '').split('@')[0];
  const args = text.slice(cmdEntity.offset + cmdEntity.length).trim();

  return { command: cleanCommand, args };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming Telegram webhook request.
 *
 * @param body     The parsed JSON body of the webhook request (a TelegramUpdate).
 * @param env      Worker environment bindings (must contain TELEGRAM_BOT_TOKEN).
 * @returns        A Response to return to the caller (Telegram expects 200).
 */
export async function handleTelegramWebhook(
  body: TelegramUpdate,
  env: Record<string, unknown>,
): Promise<Response> {
  const botToken = getEnvVar(env, 'TELEGRAM_BOT_TOKEN');
  if (!botToken) {
    return errorResponse('Telegram bot token not configured', 500);
  }

  const message = body.message ?? body.edited_message;
  if (!message) {
    // Not a message-type update — acknowledge silently.
    return jsonResponse({ ok: true });
  }

  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text;

  // Ignore empty messages (stickers, images without caption, etc.)
  if (!text) {
    return jsonResponse({ ok: true });
  }

  // Handle commands
  const cmd = parseCommand(text, message.entities);

  if (cmd) {
    switch (cmd.command) {
      case 'start':
        await replyToChat(chatId, WELCOME_MESSAGE, botToken);
        return jsonResponse({ ok: true });

      case 'help':
        await replyToChat(chatId, HELP_MESSAGE, botToken);
        return jsonResponse({ ok: true });

      default:
        // Unknown command — fall through to normal processing
        break;
    }
  }

  // Normalise the message
  const userId = from ? String(from.id) : String(chatId);
  const normalized = normalizeMessage(userId, text, 'telegram', body);

  // Build a placeholder agent response.
  // In production this would call the agent layer; for now we echo back an
  // acknowledgement so the connector is fully functional end-to-end.
  const reply = `Received on Telegram from ${from?.first_name ?? 'unknown'}: "${text}"`;

  await replyToChat(chatId, reply, botToken);

  return jsonResponse({
    ok: true,
    normalized: {
      id: normalized.id,
      userId: normalized.userId,
      text: normalized.text,
      channel: normalized.channel,
      timestamp: normalized.timestamp,
    },
  });
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export { corsHeaders, jsonResponse, errorResponse } from '../utils/index.js';
