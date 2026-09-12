import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index.js';
import type { Config } from '../config.js';
import { generateDeviceKey, sendSms } from '../sms/gateway.js';
import { writeSettings } from '../mailer.js';

async function makeApp(): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'resender-gw-'));
  const config: Config = {
    port: 0,
    dataDir: dir,
    adminPassword: 'x',
    isDefaultPassword: false,
    sessionSecret: 'secret',
    baseUrl: 'http://localhost:3000',
    trustProxy: false,
    dbPath: join(dir, 'resender.db'),
  };
  const app = await buildServer(config);
  await app.ready();
  return { app, dir };
}

test('gateway routes: register, status update and inbound SMS', async (t) => {
  const { app, dir } = await makeApp();
  t.after(async () => {
    await app.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });
  const db = (app as unknown as { db?: unknown }).db;
  assert.equal(db, undefined); // db is private to the context; use the routes only.

  // Create a device the way the admin UI does (directly in SQLite here).
  const key = generateDeviceKey();
  const ctxDb = (await import('../db.js')).openDb(join(dir, 'resender.db'));
  ctxDb.prepare(`INSERT INTO sms_devices (id, name, api_key_hash, api_key_prefix, is_default) VALUES (?, ?, ?, ?, 1)`).run(
    'dev1',
    'Test phone',
    key.hash,
    key.prefix,
  );

  // Missing / wrong key.
  let res = await app.inject({ method: 'POST', url: '/api/v1/gateway/devices', payload: {} });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url: '/api/v1/gateway/devices', headers: { 'x-api-key': 'rsd_nope' }, payload: {} });
  assert.equal(res.statusCode, 401);

  // Register.
  res = await app.inject({
    method: 'POST',
    url: '/api/v1/gateway/devices',
    headers: { 'x-api-key': key.key },
    payload: { fcmToken: 'fcm-token-1', enabled: true, brand: 'google', model: 'Pixel 7', appVersionCode: 5 },
  });
  assert.equal(res.statusCode, 201, res.body);
  const registered = res.json() as { success: boolean; data: { _id: string; model: string } };
  assert.equal(registered.success, true);
  assert.equal(registered.data._id, 'dev1');
  assert.equal(registered.data.model, 'Pixel 7');

  // Wrong device id for this key.
  res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/gateway/devices/other',
    headers: { 'x-api-key': key.key },
    payload: { fcmToken: 'fcm-token-2' },
  });
  assert.equal(res.statusCode, 403);

  // Update token via PATCH (what the app does on boot / token refresh).
  res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/gateway/devices/dev1',
    headers: { 'x-api-key': key.key },
    payload: { fcmToken: 'fcm-token-2' },
  });
  assert.equal(res.statusCode, 200);
  const device = ctxDb.prepare('SELECT fcm_token, registered_at FROM sms_devices WHERE id = ?').get('dev1') as {
    fcm_token: string;
    registered_at: string | null;
  };
  assert.equal(device.fcm_token, 'fcm-token-2');
  assert.ok(device.registered_at);

  // Queue an outbound SMS with a fake FCM transport, then report status like the phone does.
  writeSettings(ctxDb, {
    fcm_service_account: JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      private_key: '-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----\n',
      client_email: 'svc@p.iam.gserviceaccount.com',
    }),
  });
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ name: 'projects/p/messages/1' }), { status: 200 });
  }) as typeof fetch;
  // getAccessToken signs a JWT; with a bogus key that fails, so stub via a token already cached is not
  // possible here. Instead exercise the failure path and the status path independently.
  const queued = await sendSms(ctxDb, { to: '+61400000000', message: 'hello', deviceId: 'dev1' }, { fetch: fakeFetch });
  assert.equal(queued.status, 'failed');
  assert.match(queued.error ?? '', /access token/);

  // Insert a queued message directly and drive the status transitions.
  ctxDb
    .prepare(
      `INSERT INTO sms_messages (id, device_id, direction, recipient, message, status) VALUES ('m1', 'dev1', 'outbound', '+61400000000', 'hi', 'queued')`,
    )
    .run();
  res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/gateway/devices/dev1/sms-status',
    headers: { 'x-api-key': key.key },
    payload: { smsId: 'm1', smsBatchId: 'm1', status: 'SENT', sentAtInMillis: 1_700_000_000_000, deliveredAtInMillis: 0, failedAtInMillis: 0 },
  });
  assert.equal(res.statusCode, 200, res.body);
  res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/gateway/devices/dev1/sms-status',
    headers: { 'x-api-key': key.key },
    payload: { smsId: 'm1', smsBatchId: 'm1', status: 'DELIVERED', deliveredAtInMillis: 1_700_000_005_000 },
  });
  assert.equal(res.statusCode, 200, res.body);
  // A late SENT must not regress DELIVERED.
  res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/gateway/devices/dev1/sms-status',
    headers: { 'x-api-key': key.key },
    payload: { smsId: 'm1', status: 'SENT' },
  });
  assert.equal(res.statusCode, 200);
  const m1 = ctxDb.prepare('SELECT status, sent_at, delivered_at FROM sms_messages WHERE id = ?').get('m1') as {
    status: string;
    sent_at: string;
    delivered_at: string;
  };
  assert.equal(m1.status, 'delivered');
  assert.equal(m1.sent_at, '2023-11-14 22:13:20');
  assert.equal(m1.delivered_at, '2023-11-14 22:13:25');

  res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/gateway/devices/dev1/sms-status',
    headers: { 'x-api-key': key.key },
    payload: { smsId: 'missing', status: 'FAILED' },
  });
  assert.equal(res.statusCode, 404);

  // Inbound SMS.
  res = await app.inject({
    method: 'POST',
    url: '/api/v1/gateway/devices/dev1/receive-sms',
    headers: { 'x-api-key': key.key },
    payload: { sender: '+61400000001', message: 'Thanks!', receivedAtInMillis: 1_700_000_010_000 },
  });
  assert.equal(res.statusCode, 200, res.body);
  const inbound = ctxDb.prepare(`SELECT sender, message, status, received_at FROM sms_messages WHERE direction = 'inbound'`).get() as {
    sender: string;
    message: string;
    status: string;
    received_at: string;
  };
  assert.deepEqual(inbound, { sender: '+61400000001', message: 'Thanks!', status: 'received', received_at: '2023-11-14 22:13:30' });

  ctxDb.close();
});
