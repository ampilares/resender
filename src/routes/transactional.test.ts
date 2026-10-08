import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { transactionalRoutes } from './transactional.js';

const token = 'rtk_' + 'a'.repeat(64);
const keyHash = createHash('sha256').update(token).digest('hex');
const payload = { to: 'member@example.com', subject: 'Weekly digest', text: 'Hello' };
async function setup(deliver: Parameters<typeof transactionalRoutes>[1]['deliver'], dailyLimit = 100) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('smtp_email', 'sender@example.com'), ('smtp_password', 'test-only');");
  const app = Fastify();
  await app.register(transactionalRoutes, { db, keyHash, dailyLimit, deliver });
  await app.ready();
  return { app, db, send: (key: string, body: unknown = payload, headers: Record<string,string> = {}) => app.inject({
    method: 'POST', url: '/api/v1/transactional/send', payload: body as typeof payload,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, ...headers },
  }) };
}
test('separate credential, strict recipient scope, replay and rolling cap', async t => {
  let sends = 0;
  const { app, db, send } = await setup(async (_settings, message) => {
    sends++; assert.equal(message.to, payload.to); return { messageId: 'smtp-id' };
  }, 1);
  t.after(async () => { await app.close(); db.close(); });
  assert.equal((await send('one', payload, { authorization: 'Bearer rsk_formkey' })).statusCode, 401);
  assert.equal((await send('one', payload, { origin: 'https://example.com' })).statusCode, 403);
  assert.equal((await send('one', { ...payload, from: 'spoof@example.com' })).statusCode, 400);
  assert.equal((await send('one', { ...payload, to: ['a@example.com','b@example.com'] })).statusCode, 400);
  assert.equal((await send('one')).statusCode, 200);
  assert.equal((await send('one')).statusCode, 200);
  assert.equal(sends, 1);
  assert.equal((await send('one', { ...payload, text: 'changed' })).statusCode, 409);
  assert.equal((await send('two')).statusCode, 429);
});
test('concurrent retries and ambiguous SMTP failures cannot send twice', async t => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let sends = 0;
  const { app, db, send } = await setup(async () => { sends++; entered(); await pending; return { error: 'private smtp details' }; });
  t.after(async () => { await app.close(); db.close(); });
  const first = send('one').then(r => r);
  await started;
  assert.equal((await send('one')).statusCode, 409);
  release();
  const failed = await first;
  assert.equal(failed.statusCode, 502);
  assert.ok(!failed.body.includes('private smtp details'));
  assert.equal((await send('one')).statusCode, 409);
  assert.equal(sends, 1);
});
