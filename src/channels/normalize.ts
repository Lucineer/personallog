/**
 * channels/normalize.ts — Shared normalisation and dispatch for channel connectors
 *
 * Every platform connector (Telegram, Discord, WhatsApp) normalises inbound
 * messages into a NormalizedMessage so the agent layer can treat them
 * uniformly.  This module defines that type and provides helpers for
 * cross-platform message sending.
 */

import { generateId } from '../utils/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Channel = 'telegram' | 'discord' | 'whatsapp';

/** Platform-agnostic message produced by every connector. */
export interface NormalizedMessage {
  /** Unique ID for this normalised message (generated on arrival). */
  id: string;
  /** Platform-specific user identifier. */
  userId: string;
  /** The text payload the user sent. */
  text: string;
  /** Which channel this message arrived on. */
  channel: Channel;
  /** ISO-8601 timestamp of when the message was received / normalised. */
  timestamp: string;
  /** The raw platform-specific payload (kept for debugging / forwarding). */
  raw: unknown;
}

/** Configuration for sending outbound messages to a platform. */
export interface ChannelConfig {
  telegram?: {
    botToken: string;
  };
  discord?: {
    botToken: string;
    applicationId: string;
    interactionToken?: string; // For interaction responses (webhook followups)
  };
  whatsapp?: {
    phoneNumberId: string;
    accessToken: string;
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a raw platform message into a NormalizedMessage.
 *
 * The `raw` field is stored verbatim; callers should extract `userId` and
 * `text` before calling this helper, or pass them directly.
 */
export function normalizeMessage(
  userId: string,
  text: string,
  channel: Channel,
  raw: unknown,
): NormalizedMessage {
  return {
    id: generateId(),
    userId,
    text,
    channel,
    timestamp: new Date().toISOString(),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/** Send a text response back to the originating platform. */
export async function sendMessage(
  platform: Channel,
  userId: string,
  text: string,
  config: ChannelConfig,
): Promise<Response> {
  switch (platform) {
    case 'telegram':
      return sendTelegramMessage(userId, text, config.telegram!.botToken);
    case 'discord':
      return sendDiscordMessage(userId, text, config.discord!);
    case 'whatsapp':
      return sendWhatsAppMessage(userId, text, config.whatsapp!);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

// -- Telegram ---------------------------------------------------------------

async function sendTelegramMessage(
  chatId: string,
  text: string,
  botToken: string,
): Promise<Response> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
}

// -- Discord ----------------------------------------------------------------

async function sendDiscordMessage(
  userId: string,
  text: string,
  config: NonNullable<ChannelConfig['discord']>,
): Promise<Response> {
  // If we have an interaction token we can use the webhook followup endpoint.
  if (config.interactionToken) {
    const url = `https://discord.com/api/v10/webhooks/${config.applicationId}/${config.interactionToken}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
  }

  // Otherwise open a DM channel first, then send.
  const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${config.botToken}`,
    },
    body: JSON.stringify({ recipient_id: userId }),
  });

  if (!dmRes.ok) {
    const errText = await dmRes.text();
    throw new Error(`Failed to open DM channel: ${dmRes.status} ${errText}`);
  }

  const dm = await dmRes.json() as { id: string };
  return fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${config.botToken}`,
    },
    body: JSON.stringify({ content: text }),
  });
}

// -- WhatsApp ---------------------------------------------------------------

async function sendWhatsAppMessage(
  userId: string,
  text: string,
  config: NonNullable<ChannelConfig['whatsapp']>,
): Promise<Response> {
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: userId,
      type: 'text',
      text: { body: text },
    }),
  });
}
