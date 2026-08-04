import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTurnstile } from './turnstile.js';

test('missing tokens fail locally without calling Siteverify', async () => {
  let calls = 0;
  const result = await verifyTurnstile({
    secretKey: 'secret',
    token: undefined,
    fetchImpl: (async () => {
      calls += 1;
      throw new Error('should not be called');
    }) as typeof fetch,
  });

  assert.equal(result.success, false);
  assert.equal(result.unavailable, false);
  assert.deepEqual(result.errors, ['missing-input-response']);
  assert.equal(calls, 0);
});

test('validates action and hostname and sends server-side verification data', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const result = await verifyTurnstile({
    secretKey: 'secret',
    token: 'token',
    remoteIp: '203.0.113.7',
    expectedAction: 'resender_form',
    expectedHostname: 'example.com',
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ success: true, action: 'resender_form', hostname: 'example.com' }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  assert.equal(result.success, true);
  assert.equal(requestBody?.secret, 'secret');
  assert.equal(requestBody?.response, 'token');
  assert.equal(requestBody?.remoteip, '203.0.113.7');
  assert.equal(typeof requestBody?.idempotency_key, 'string');
});

test('rejects tokens solved for a different hostname', async () => {
  const result = await verifyTurnstile({
    secretKey: 'secret',
    token: 'token',
    expectedAction: 'resender_form',
    expectedHostname: 'example.com',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ success: true, action: 'resender_form', hostname: 'attacker.example' }), {
        status: 200,
      })) as typeof fetch,
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.errors, ['hostname-mismatch']);
});

test('retries transient Siteverify failures with the same operation', async () => {
  let calls = 0;
  const result = await verifyTurnstile({
    secretKey: 'secret',
    token: 'token',
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1
        ? new Response('temporary failure', { status: 503 })
        : new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(result.success, true);
  assert.equal(calls, 2);
});
