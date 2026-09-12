import { createSign } from 'node:crypto';
import { z } from 'zod';

/**
 * Minimal Firebase Cloud Messaging HTTP v1 client. Uses a service-account key
 * to mint an OAuth2 access token (RS256 JWT bearer grant) and POSTs data
 * messages to the FCM v1 endpoint. No firebase-admin dependency: resender
 * only needs "send one data message to one device token".
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

const serviceAccountSchema = z.object({
  type: z.literal('service_account', {
    errorMap: () => ({ message: 'JSON must be a Firebase service account (type "service_account").' }),
  }),
  project_id: z.string().min(1, 'project_id missing'),
  private_key: z.string().min(1, 'private_key missing'),
  client_email: z.string().email('client_email must be an email address'),
  token_uri: z.string().url().optional(),
});

/** Parse and validate a service-account JSON document. Throws an Error with a user-facing message. */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Service account must be valid JSON.');
  }
  const parsed = serviceAccountSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid service account: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  const { project_id, client_email, token_uri } = parsed.data;
  // Env-style copies often carry literal "\n" sequences; PEM needs real newlines.
  const private_key = parsed.data.private_key.replace(/\\n/g, '\n');
  if (!private_key.includes('-----BEGIN')) {
    throw new Error('Invalid service account: private_key is not a PEM key.');
  }
  return { project_id, private_key, client_email, token_uri: token_uri ?? DEFAULT_TOKEN_URI };
}

export interface FcmOptions {
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Build the signed JWT used for the OAuth2 jwt-bearer grant. Exported for tests. */
export function createJwt(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: sa.token_uri,
      iat,
      exp: iat + TOKEN_TTL_SECONDS,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Drop cached access tokens (used when credentials change and in tests). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/** Exchange the service-account JWT for an access token, with in-memory caching. Throws on failure. */
export async function getAccessToken(sa: ServiceAccount, opts: FcmOptions = {}): Promise<string> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const cacheKey = `${sa.client_email}:${sa.project_id}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: createJwt(sa, now()),
  });
  const res = await doFetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint returned ${res.status}: ${await readErrorBody(res)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Google token endpoint returned no access_token.');
  const ttlMs = (json.expires_in ?? TOKEN_TTL_SECONDS) * 1000;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: now() + ttlMs });
  return json.access_token;
}

export interface FcmDataMessage {
  /** Device registration token. */
  token: string;
  /** String-only data payload (FCM requires string values). */
  data: Record<string, string>;
}

export interface FcmSendResult {
  /** FCM message name (projects/x/messages/y) on success. */
  messageName?: string;
  error?: string;
  /** True when FCM reports the device token is no longer valid. */
  unregistered?: boolean;
}

interface FcmErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ '@type'?: string; errorCode?: string }>;
  };
}

/**
 * Send a high-priority data message to one device. Never throws: returns
 * { error } (and unregistered=true when the token should be discarded).
 */
export async function sendDataMessage(
  sa: ServiceAccount,
  message: FcmDataMessage,
  opts: FcmOptions = {},
): Promise<FcmSendResult> {
  const doFetch = opts.fetch ?? fetch;
  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa, opts);
  } catch (err) {
    return { error: describe(err, 'Could not obtain a Firebase access token') };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: message.token,
          data: message.data,
          android: { priority: 'high' },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: describe(err, 'FCM request failed') };
  }

  if (res.ok) {
    try {
      const json = (await res.json()) as { name?: string };
      return { messageName: json.name };
    } catch {
      return { messageName: undefined };
    }
  }

  // Auth failures should not poison the cache for the next attempt.
  if (res.status === 401) clearTokenCache();

  let body: FcmErrorBody = {};
  try {
    body = (await res.json()) as FcmErrorBody;
  } catch {
    // non-JSON error body
  }
  const fcmError = body.error;
  const errorCode = fcmError?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode;
  const unregistered =
    errorCode === 'UNREGISTERED' ||
    (res.status === 404 && fcmError?.status === 'NOT_FOUND') ||
    (errorCode === 'INVALID_ARGUMENT' && /registration token/i.test(fcmError?.message ?? ''));
  const detail = fcmError?.message ?? (await readErrorBody(res)) ?? '';
  const code = errorCode ?? fcmError?.status ?? String(res.status);
  return { error: `FCM ${code}: ${detail || 'request rejected'}`.trim(), unregistered };
}

function describe(err: unknown, prefix: string): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `${prefix}: timed out`;
    return `${prefix}: ${err.message}`;
  }
  return `${prefix}: ${String(err)}`;
}
