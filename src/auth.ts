import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import type { FastifyReply, FastifyRequest } from 'fastify';

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const nanoKey = customAlphabet(KEY_ALPHABET, 32);

export interface GeneratedKey {
  key: string;
  hash: string;
  prefix: string;
}

/** Generate a new `rsk_` API key plus its sha256 hash and 8-char prefix. */
export function generateApiKey(): GeneratedKey {
  const key = `rsk_${nanoKey()}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}

/** sha256 hash (hex) of a full API key, as stored in the DB. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export const SESSION_COOKIE = 'resender_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sign a session token as `<expiryMs>.<hmac>`. No session table is needed: the
 * cookie is self-describing and its integrity is guaranteed by the HMAC over the
 * expiry, keyed by SESSION_SECRET.
 */
function sign(expiry: number, secret: string): string {
  const hmac = createHmac('sha256', secret).update(String(expiry)).digest('hex');
  return `${expiry}.${hmac}`;
}

export function createSessionToken(secret: string, now = Date.now()): string {
  return sign(now + SESSION_TTL_MS, secret);
}

/** Verify a session token: correct HMAC and not expired. */
export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiryStr = token.slice(0, dot);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < now) return false;

  const expected = sign(expiry, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time password comparison that tolerates differing lengths. */
export function passwordMatches(provided: string, expected: string): boolean {
  const a = createHmac('sha256', 'pw').update(provided).digest();
  const b = createHmac('sha256', 'pw').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function isAuthenticated(request: FastifyRequest, secret: string): boolean {
  const token = request.cookies[SESSION_COOKIE];
  return verifySessionToken(token, secret);
}
