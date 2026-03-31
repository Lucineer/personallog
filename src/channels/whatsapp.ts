/**
 * channels/whatsapp.ts — WhatsApp (Meta) webhook handler
 *
 * Handles both the GET verification handshake and POST notification
 * payloads from the Meta Graph API. Normalises inbound messages and sends
 * text replies via the messages endpoint.
 *
 * Env variables used:
 *   WHATSAPP_VERIFY_TOKEN  — Token you configure in the Meta dashboard
 *   WHATSAPP_ACCESS_TOKEN  — Permanent or temporary access token
 *   WHATSAPP_PHONE_NUMBER_ID — Phone number ID from the dashboard
 */

import { normalizeMessage, type NormalizedMessage } from './normalize.js';
import { corsHeaders, jsonResponse, errorResponse, getEnvVar } from '../utils/index.js';

// ---------------------------------------------------------------------------
// WhatsApp types
// ---------------------------------------------------------------------------

interface WhatsAppText {
  body: string;
}

interface WhatsAppMessage {
  from: string;           // WhatsApp user phone number (e.g. "15551234567")
  id: string;             // Message ID (e.g. "wamid.HBgM...")
  timestamp: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'location' | 'contacts' | 'reaction' | 'interactive' | 'button' | 'template';
  text?: WhatsAppText;
  image?: { caption?: string; id: string; mime_type: string; sha256: string };
  document?: { caption?: string; id: string; mime_type: string; sha256: string; filename?: string };
  audio?: { id: string; mime_type: string; sha256: string };
  video?: { caption?: string; id: string; mime_type: string; sha256: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: Record<string, unknown>;
  context?: {
    forwarded?: boolean;
    id?: string;
    quoted?: { id: string };
  };
}

interface WhatsAppContact {
  wa_id: string;
  profile?: { name?: string };
}

interface WhatsAppValue {
  messaging_product: string;
  metadata?: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: Array<{
    id: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    timestamp: string;
    recipient_id: string;
    errors?: Array<{ code: number; title: string; message: string }>;
  }>;
}

interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

interface WhatsAppEntry {
  id: string;
  changes?: WhatsAppChange[];
}

/** Top-level webhook payload POSTed by Meta. */
export interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppEntry[];
}

// ---------------------------------------------------------------------------
// GET — Webhook verification
// ---------------------------------------------------------------------------

/**
 * Handle the GET verification request Meta sends when you configure
 * the webhook in the dashboard.
 *
 * Meta sends:
 *   hub.mode          — must be "subscribe"
 *   hub.verify_token  — must match your WHATSAPP_VERIFY_TOKEN
 *   hub.challenge     — must be echoed back in the response body
 */
export function handleWhatsAppVerification(
  url: URL,
  env: Record<string, unknown>,
): Response {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const verifyToken = getEnvVar(env, 'WHATSAPP_VERIFY_TOKEN');

  if (!verifyToken) {
    return errorResponse('WhatsApp verify token not configured', 500);
  }

  if (mode !== 'subscribe' || token !== verifyToken) {
    return errorResponse('Verification failed', 403);
  }

  if (!challenge) {
    return errorResponse('Missing hub.challenge', 400);
  }

  // Meta expects the challenge as plain text in a 200 response
  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain', ...corsHeaders() },
  });
}

// ---------------------------------------------------------------------------
// POST — Inbound messages
// ---------------------------------------------------------------------------

/**
 * Extract the best text representation from a WhatsApp message, regardless
 * of its specific type.
 */
function extractText(msg: WhatsAppMessage): string {
  switch (msg.type) {
    case 'text':
      return msg.text?.body ?? '';
    case 'image':
      return msg.image?.caption ?? '[Image]';
    case 'document':
      return msg.document?.caption ?? msg.document?.filename ?? '[Document]';
    case 'audio':
      return '[Audio]';
    case 'video':
      return msg.video?.caption ?? '[Video]';
    case 'location':
      return `[Location] ${msg.location?.name ?? `${msg.location?.latitude}, ${msg.location?.longitude}`}`;
    case 'sticker':
      return '[Sticker]';
    case 'contacts':
      return '[Contacts]';
    case 'reaction':
      return '[Reaction]';
    case 'interactive':
      return '[Interactive]';
    case 'button':
      return '[Button]';
    case 'template':
      return '[Template]';
    default:
      return `[${msg.type}]`;
  }
}

/** Send a text message via the Meta Graph API. */
async function sendWhatsAppReply(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<Response> {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}

/**
 * Handle an inbound POST from Meta containing messages or status updates.
 *
 * @param payload  The parsed WhatsAppWebhookPayload.
 * @param env      Worker environment bindings.
 * @returns        A Response (Meta expects 200 quickly).
 */
export async function handleWhatsAppMessage(
  payload: WhatsAppWebhookPayload,
  env: Record<string, unknown>,
): Promise<Response> {
  const accessToken = getEnvVar(env, 'WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = getEnvVar(env, 'WHATSAPP_PHONE_NUMBER_ID');

  // Iterate over all entries and changes
  const normalizedMessages: NormalizedMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Process only message changes (ignore statuses for now)
      if (change.field !== 'messages') continue;

      const messages = change.value.messages;
      if (!messages) continue;

      for (const msg of messages) {
        const text = extractText(msg);
        const userId = msg.from;

        // Get the contact name if available
        const contactName = change.value.contacts?.[0]?.profile?.name;

        // Normalise the message
        const normalized = normalizeMessage(userId, text, 'whatsapp', msg);
        normalizedMessages.push(normalized);

        // Only send a reply for text-type messages to avoid spamming
        // responses to every media/status event
        if (msg.type === 'text' && accessToken && phoneNumberId) {
          const displayName = contactName ?? userId;
          const reply = `Hi ${displayName}! I received your message: "${text}"`;

          // Fire-and-forget: we do not await the reply to respond to Meta
          // quickly.  Use waitUntil in the worker to handle this properly.
          // For now we await it so the caller can use waitUntil externally.
          await sendWhatsAppReply(userId, reply, phoneNumberId, accessToken);
        }
      }
    }
  }

  return jsonResponse({
    ok: true,
    processed: normalizedMessages.length,
    messages: normalizedMessages.map((m) => ({
      id: m.id,
      userId: m.userId,
      text: m.text,
      channel: m.channel,
      timestamp: m.timestamp,
    })),
  });
}

// ---------------------------------------------------------------------------
// Main handler — routes GET vs POST
// ---------------------------------------------------------------------------

/**
 * Top-level handler for the WhatsApp webhook endpoint.
 *
 * GET  → verification handshake
 * POST → inbound message processing
 */
export async function handleWhatsAppWebhook(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response> {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    return handleWhatsAppVerification(url, env);
  }

  if (request.method === 'POST') {
    let payload: WhatsAppWebhookPayload;
    try {
      payload = await request.json() as WhatsAppWebhookPayload;
    } catch {
      return errorResponse('Invalid JSON payload', 400);
    }

    // Meta can send webhooks for objects other than whatsapp; ignore them
    if (payload.object !== 'whatsapp_business_account') {
      return jsonResponse({ ok: true, skipped: true });
    }

    return handleWhatsAppMessage(payload, env);
  }

  return errorResponse('Method not allowed', 405);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { corsHeaders, jsonResponse, errorResponse } from '../utils/index.js';
