import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { readSettings, sendEmail } from '../mailer.js';

interface Options {
  db: DB;
  keyHash?: string;
  dailyLimit?: number;
  deliver?: typeof sendEmail;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const schema = z.object({
  to: z.string().email().max(254),
  subject: z.string().min(1).max(200).regex(/^[^\r\n]+$/),
  text: z.string().min(1).max(100_000),
}).strict();

/** Separate server credential: contact-form keys never authorize arbitrary recipients. */
export const transactionalRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const { db, keyHash, dailyLimit = 100, deliver = sendEmail } = options;
  if (keyHash && !/^[a-f0-9]{64}$/.test(keyHash)) throw new Error('Invalid TRANSACTIONAL_API_KEY_SHA256');
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) throw new Error('Invalid TRANSACTIONAL_DAILY_LIMIT');
  db.exec(`CREATE TABLE IF NOT EXISTS transactional_messages (
    id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL,
    message_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); CREATE INDEX IF NOT EXISTS transactional_messages_created ON transactional_messages(created_at);`);

  app.post('/api/v1/transactional/send', { bodyLimit: 110_000 }, async (request, reply) => {
    const token = /^Bearer (rtk_[a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!keyHash || !token || !timingSafeEqual(Buffer.from(sha(token), 'hex'), Buffer.from(keyHash, 'hex'))) {
      return reply.code(401).send({ ok: false, error: 'Invalid transactional API key.' });
    }
    if (request.headers.origin) return reply.code(403).send({ ok: false, error: 'Server-to-server requests only.' });
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,150}$/.test(key)) {
      return reply.code(400).send({ ok: false, error: 'A valid Idempotency-Key is required.' });
    }
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Expected one recipient, subject and plain-text body.' });
    const id = sha(key);
    const hash = sha(JSON.stringify(parsed.data));
    const previous = db.prepare('SELECT request_hash, status FROM transactional_messages WHERE id = ?').get(id) as
      { request_hash: string; status: string } | undefined;
    if (previous) {
      if (previous.request_hash !== hash) return reply.code(409).send({ ok: false, error: 'Idempotency key reused with different content.' });
      if (previous.status === 'sent') return { ok: true, id };
      return reply.code(409).send({ ok: false, error: 'Delivery is pending or uncertain; operator reconciliation required.' });
    }
    const settings = readSettings(db);
    if (!settings.smtp_email || !settings.smtp_password) {
      return reply.code(503).send({ ok: false, error: 'Email delivery is not configured.' });
    }
    const reserved = db.transaction(() => {
      const count = (db.prepare("SELECT count(*) AS n FROM transactional_messages WHERE created_at >= datetime('now', '-1 day')").get() as { n: number }).n;
      if (count >= dailyLimit) return false;
      db.prepare("INSERT INTO transactional_messages(id, request_hash, status) VALUES (?, ?, 'sending')").run(id, hash);
      return true;
    })();
    if (!reserved) return reply.code(429).header('Retry-After', '3600').send({ ok: false, error: 'Daily transactional limit reached.' });
    // Reserve before SMTP. A timeout or crash must never cause an automatic duplicate.
    try {
      const result = await deliver(settings, parsed.data);
      if (result.error) throw new Error('SMTP delivery outcome uncertain');
      db.prepare("UPDATE transactional_messages SET status = 'sent', message_id = ? WHERE id = ?").run(result.messageId ?? null, id);
      return { ok: true, id };
    } catch {
      db.prepare("UPDATE transactional_messages SET status = 'unknown' WHERE id = ?").run(id);
      return reply.code(502).send({ ok: false, error: 'Delivery outcome uncertain; retry with the same idempotency key.' });
    }
  });
};
