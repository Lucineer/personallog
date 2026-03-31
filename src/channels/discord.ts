/**
 * channels/discord.ts — Discord Bot webhook handler (Interactions endpoint)
 *
 * Receives Discord Interaction payloads, verifies Ed25519 signatures using
 * WebCrypto, normalises commands/messages, and returns interaction responses.
 *
 * Env variables used:
 *   DISCORD_PUBLIC_KEY — Application public key for signature verification
 *   DISCORD_BOT_TOKEN  — Bot token for outgoing API calls
 */

import { normalizeMessage, type NormalizedMessage } from './normalize.js';
import { corsHeaders, jsonResponse, errorResponse, getEnvVar } from '../utils/index.js';

// ---------------------------------------------------------------------------
// Discord types
// ---------------------------------------------------------------------------

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string;
  avatar?: string;
  bot?: boolean;
  system?: boolean;
}

interface DiscordInteractionDataOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionDataOption[];
}

interface DiscordInteractionData {
  id: string;
  name: string;
  type: number;
  options?: DiscordInteractionDataOption[];
  resolved?: Record<string, unknown>;
}

interface DiscordMember {
  user?: DiscordUser;
  nick?: string;
  roles: string[];
  joined_at: string;
}

/** Top-level Interaction object sent by Discord. */
export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: DiscordInteractionType;
  data?: DiscordInteractionData;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: DiscordMember;
  user?: DiscordUser; // Present in DM interactions
  message?: Record<string, unknown>;
  locale?: string;
  guild_locale?: string;
}

enum DiscordInteractionType {
  PING = 1,
  APPLICATION_COMMAND = 2,
  MESSAGE_COMPONENT = 3,
  APPLICATION_COMMAND_AUTOCOMPLETE = 4,
  MODAL_SUBMIT = 5,
}

/** Shape of a Discord interaction response. */
interface DiscordInteractionResponse {
  type: number;
  data?: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
    flags?: number;
    allowed_mentions?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Signature verification (Ed25519 via WebCrypto)
// ---------------------------------------------------------------------------

/**
 * Verify that a request was genuinely sent by Discord.
 *
 * Discord sends two headers:
 *   X-Signature-Timestamp — the timestamp string
 *   X-Signature-Ed25519   — 64-byte hex-encoded Ed25519 signature
 *
 * The signed payload is `timestamp + rawBody`.
 */
async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  try {
    // Decode hex-encoded signature to Uint8Array
    const signatureBytes = hexToBytes(signatureHex);
    if (signatureBytes.length !== 64) return false;

    // Import the public key from hex
    const publicKeyBytes = hexToBytes(publicKeyHex);
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'ed25519', namedCurve: 'ed25519' },
      false,
      ['verify'],
    );

    // Construct the message that was signed: timestamp + body
    const message = new TextEncoder().encode(timestamp + body);

    return crypto.subtle.verify('ed25519', publicKey, signatureBytes, message);
  } catch {
    return false;
  }
}

/** Convert a hex string to a Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

/** Build a simple message response (type 4 = CHANNEL_MESSAGE_WITH_SOURCE). */
function messageResponse(
  content: string,
  flags?: number,
): DiscordInteractionResponse {
  return {
    type: 4,
    data: {
      content,
      ...(flags !== undefined ? { flags } : {}),
    },
  };
}

/** Extract the effective user from an interaction (works for guild + DM). */
function getUser(interaction: DiscordInteraction): DiscordUser | undefined {
  return interaction.user ?? interaction.member?.user;
}

/** Flatten interaction options into a simple key-value map. */
function extractOptions(
  options?: DiscordInteractionDataOption[],
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (!options) return result;
  for (const opt of options) {
    if (opt.value !== undefined) {
      result[opt.name] = opt.value;
    }
    // Recurse into sub-options if present
    if (opt.options) {
      Object.assign(result, extractOptions(opt.options));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle a Discord Interaction webhook request.
 *
 * @param request  The incoming Request object from the worker fetch handler.
 * @param env      Worker environment bindings.
 * @returns        A Response to return to Discord.
 */
export async function handleDiscordWebhook(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response> {
  const publicKey = getEnvVar(env, 'DISCORD_PUBLIC_KEY');
  if (!publicKey) {
    return errorResponse('Discord public key not configured', 500);
  }

  // Read raw body for signature verification
  const rawBody = await request.text();

  // Verify signature
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  if (!signature || !timestamp) {
    return errorResponse('Missing signature headers', 401);
  }

  const isValid = await verifyDiscordSignature(publicKey, signature, timestamp, rawBody);
  if (!isValid) {
    return errorResponse('Invalid request signature', 401);
  }

  // Parse the interaction payload
  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return errorResponse('Invalid JSON payload', 400);
  }

  // Handle PING (Discord verifies the endpoint on registration)
  if (interaction.type === DiscordInteractionType.PING) {
    return jsonResponse({ type: 1 });
  }

  // Handle APPLICATION_COMMAND
  if (interaction.type === DiscordInteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name ?? 'unknown';
    const user = getUser(interaction);
    const options = extractOptions(interaction.data?.options);

    // Build user-visible text from command + options
    const parts = [`/${commandName}`];
    for (const [key, value] of Object.entries(options)) {
      parts.push(`${key}: ${value}`);
    }
    const text = parts.join(' ');

    // Normalise the message
    const userId = user?.id ?? 'unknown';
    const normalized = normalizeMessage(userId, text, 'discord', interaction);

    // Build a placeholder response
    // In production this would dispatch to the agent layer.
    const reply = `Hey ${user?.global_name ?? user?.username ?? 'there'}! I received your command: ${text}`;

    return jsonResponse(messageResponse(reply));
  }

  // Handle MESSAGE_COMPONENT (button clicks, select menus, etc.)
  if (interaction.type === DiscordInteractionType.MESSAGE_COMPONENT) {
    const user = getUser(interaction);
    const customId = (interaction.data as unknown as Record<string, unknown>)?.name as string ?? '';

    const userId = user?.id ?? 'unknown';
    const normalized = normalizeMessage(userId, `component:${customId}`, 'discord', interaction);

    const reply = `You interacted with: ${customId}`;
    return jsonResponse(messageResponse(reply));
  }

  // APPLICATION_COMMAND_AUTOCOMPLETE — return empty choices
  if (interaction.type === DiscordInteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return jsonResponse({
      type: 8,
      data: { choices: [] },
    });
  }

  // MODAL_SUBMIT — acknowledge
  if (interaction.type === DiscordInteractionType.MODAL_SUBMIT) {
    const user = getUser(interaction);
    const userId = user?.id ?? 'unknown';
    const normalized = normalizeMessage(userId, 'modal_submit', 'discord', interaction);

    return jsonResponse(messageResponse('Modal submitted successfully.'));
  }

  // Unknown interaction type
  return errorResponse('Unsupported interaction type', 400);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { corsHeaders, jsonResponse, errorResponse } from '../utils/index.js';
