import { randomUUID } from 'node:crypto';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export interface TurnstileVerification {
  success: boolean;
  unavailable: boolean;
  hostname?: string;
  errors: string[];
}

interface VerifyOptions {
  secretKey: string;
  token: string | undefined;
  remoteIp?: string;
  expectedHostname?: string;
  expectedAction?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function verifyTurnstile(options: VerifyOptions): Promise<TurnstileVerification> {
  if (!options.token) {
    return { success: false, unavailable: false, errors: ['missing-input-response'] };
  }
  if (options.token.length > MAX_TOKEN_LENGTH) {
    return { success: false, unavailable: false, errors: ['invalid-input-response'] };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const idempotencyKey = randomUUID();
  const body = {
    secret: options.secretKey,
    response: options.token,
    remoteip: options.remoteIp,
    idempotency_key: idempotencyKey,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
    try {
      const response = await fetchImpl(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt === 0 && response.status >= 500) continue;
        return { success: false, unavailable: true, errors: [`siteverify-http-${response.status}`] };
      }

      const result = (await response.json()) as SiteverifyResponse;
      const errors = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
      if (!result.success) {
        const unavailable = errors.includes('internal-error');
        if (unavailable && attempt === 0) continue;
        return { success: false, unavailable, hostname: result.hostname, errors };
      }
      if (options.expectedAction && result.action !== options.expectedAction) {
        return { success: false, unavailable: false, hostname: result.hostname, errors: ['action-mismatch'] };
      }
      if (options.expectedHostname && result.hostname?.toLowerCase() !== options.expectedHostname.toLowerCase()) {
        return { success: false, unavailable: false, hostname: result.hostname, errors: ['hostname-mismatch'] };
      }
      return { success: true, unavailable: false, hostname: result.hostname, errors: [] };
    } catch {
      if (attempt === 1) {
        return { success: false, unavailable: true, errors: ['siteverify-unavailable'] };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { success: false, unavailable: true, errors: ['siteverify-unavailable'] };
}
