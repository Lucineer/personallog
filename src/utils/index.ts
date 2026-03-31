/**
 * utils/index.ts — Shared utilities for personallog
 *
 * Generic helpers used across the worker: ID generation, CORS,
 * JSON responses, password hashing, and env access.
 */

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a unique ID using crypto.randomUUID (available in Workers). */
export function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Standard CORS headers for cross-origin requests. */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Signature-Ed25519, X-Signature-Timestamp',
    'Access-Control-Max-Age': '86400',
  };
}

/** Return a JSON Response with the given status code. */
export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

/** Return a JSON error Response. */
export function errorResponse(message: string, status: number = 500): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/** Parse a URL pathname into segments, filtering empty strings. */
export function parsePath(url: string | URL): string[] {
  const pathname = typeof url === 'string' ? new URL(url).pathname : url.pathname;
  return pathname.split('/').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Password hashing (WebCrypto SHA-256)
// ---------------------------------------------------------------------------

/** Hash a password using WebCrypto SHA-256. Returns hex string. */
export async function hashPassword(password: string): Promise<string> {
  const encoded = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return arrayBufferToHex(hashBuffer);
}

/** Verify a password against a stored hex hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  // Constant-time-ish comparison for hex strings
  if (computed.length !== hash.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Convert an ArrayBuffer to a lowercase hex string. */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

type EnvLike = Record<string, unknown>;

/** Safely retrieve an environment variable, returning undefined if missing. */
export function getEnvVar(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  if (typeof value === 'string') return value;
  return undefined;
}

/** Retrieve an environment variable or throw if missing. */
export function requireEnvVar(env: EnvLike, key: string): string {
  const value = getEnvVar(env, key);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
