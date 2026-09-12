import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { clearTokenCache, createJwt, parseServiceAccount, sendDataMessage, type ServiceAccount } from './fcm.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const sa: ServiceAccount = {
  project_id: 'demo-project',
  private_key: privatePem,
  client_email: 'fcm@demo-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.example/token',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('parseServiceAccount validates and normalizes the key', () => {
  const parsed = parseServiceAccount(
    JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      private_key: privatePem.replace(/\n/g, '\\n'),
      client_email: 'a@b.iam.gserviceaccount.com',
    }),
  );
  assert.equal(parsed.project_id, 'p');
  assert.equal(parsed.token_uri, 'https://oauth2.googleapis.com/token');
  assert.ok(parsed.private_key.includes('\n'));

  assert.throws(() => parseServiceAccount('not json'), /valid JSON/);
  assert.throws(() => parseServiceAccount(JSON.stringify({ type: 'user' })), /service account/);
  assert.throws(
    () =>
      parseServiceAccount(
        JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'x', client_email: 'a@b.iam.gserviceaccount.com' }),
      ),
    /PEM/,
  );
});

test('createJwt produces a verifiable RS256 token with the expected claims', () => {
  const now = 1_700_000_000_000;
  const jwt = createJwt(sa, now);
  const [header, claims, signature] = jwt.split('.');
  assert.ok(header && claims && signature);
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const c = decode(claims);
  assert.equal(c.iss, sa.client_email);
  assert.equal(c.aud, sa.token_uri);
  assert.equal(c.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(c.iat, 1_700_000_000);
  assert.equal(c.exp, 1_700_003_600);
  const ok = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, 'base64url'));
  assert.equal(ok, true);
});

test('sendDataMessage exchanges the JWT for a token, caches it, and posts the message', async () => {
  clearTokenCache();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === sa.token_uri) return jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 });
    return jsonResponse(200, { name: 'projects/demo-project/messages/abc' });
  }) as typeof fetch;

  const first = await sendDataMessage(sa, { token: 'device-token', data: { smsData: '{"a":1}' } }, { fetch: fakeFetch });
  assert.deepEqual(first, { messageName: 'projects/demo-project/messages/abc' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, sa.token_uri);
  assert.match(String(calls[0]!.init.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  assert.equal(calls[1]!.url, 'https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
  const sent = JSON.parse(String(calls[1]!.init.body)) as { message: Record<string, unknown> };
  assert.deepEqual(sent.message, {
    token: 'device-token',
    data: { smsData: '{"a":1}' },
    android: { priority: 'high' },
  });
  assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer tok-1');

  const second = await sendDataMessage(sa, { token: 'device-token', data: { smsData: '{}' } }, { fetch: fakeFetch });
  assert.equal(second.messageName, 'projects/demo-project/messages/abc');
  assert.equal(calls.length, 3, 'access token is reused from cache');
});

test('sendDataMessage reports unregistered tokens and other errors without throwing', async () => {
  clearTokenCache();
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === sa.token_uri) return jsonResponse(200, { access_token: 'tok-2', expires_in: 3600 });
    return jsonResponse(404, {
      error: {
        code: 404,
        message: 'Requested entity was not found.',
        status: 'NOT_FOUND',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
      },
    });
  }) as typeof fetch;
  const result = await sendDataMessage(sa, { token: 'dead', data: {} }, { fetch: fakeFetch });
  assert.equal(result.unregistered, true);
  assert.match(result.error ?? '', /UNREGISTERED/);

  clearTokenCache();
  const tokenFail = (async () => new Response('denied', { status: 401 })) as typeof fetch;
  const failed = await sendDataMessage(sa, { token: 'x', data: {} }, { fetch: tokenFail });
  assert.match(failed.error ?? '', /access token/);
  assert.equal(failed.unregistered, undefined);
});
