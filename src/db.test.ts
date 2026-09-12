import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_SMS_TEMPLATE, openDb } from './db.js';

test('sms gateway migration adds per-form SMS settings, device and message tables', (t) => {
  const path = join(tmpdir(), `resender-${randomUUID()}.db`);
  const db = openDb(path);
  t.after(() => {
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) unlinkSync(file);
    }
  });

  const columns = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const col of ['sms_enabled', 'sms_number', 'sms_template', 'sms_device_id']) assert.ok(columns('forms').has(col), col);
  for (const col of ['sms_status', 'sms_error', 'sms_message_id']) assert.ok(columns('submissions').has(col), col);
  assert.ok(columns('sms_devices').has('api_key_hash'));
  assert.ok(columns('sms_messages').has('direction'));

  db.prepare(
    `INSERT INTO forms (id, name, slug, destination_email, destination_emails, api_key_hash, api_key_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('f1', 'Form', 'form', 'a@example.com', '["a@example.com"]', 'h', 'rsk_test');
  const form = db.prepare('SELECT sms_enabled, sms_template, sms_number FROM forms WHERE id = ?').get('f1') as {
    sms_enabled: number;
    sms_template: string;
    sms_number: string | null;
  };
  assert.equal(form.sms_enabled, 0);
  assert.equal(form.sms_template, DEFAULT_SMS_TEMPLATE);
  assert.equal(form.sms_number, null);

  // Deleting a device keeps its message history (device_id is nulled).
  db.prepare(`INSERT INTO sms_devices (id, name, api_key_hash, api_key_prefix) VALUES ('d1', 'Phone', 'hash', 'rsd_test')`).run();
  db.prepare(
    `INSERT INTO sms_messages (id, device_id, direction, recipient, message, status) VALUES ('m1', 'd1', 'outbound', '+61400000000', 'hi', 'queued')`,
  ).run();
  db.prepare(`DELETE FROM sms_devices WHERE id = 'd1'`).run();
  const msg = db.prepare('SELECT device_id FROM sms_messages WHERE id = ?').get('m1') as { device_id: string | null };
  assert.equal(msg.device_id, null);
});

test('spam-protection migration creates audit columns and safe form defaults', (t) => {
  const path = join(tmpdir(), `resender-${randomUUID()}.db`);
  const db = openDb(path);
  t.after(() => {
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) unlinkSync(file);
    }
  });

  const formColumns = new Set(
    (db.prepare('PRAGMA table_info(forms)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const submissionColumns = new Set(
    (db.prepare('PRAGMA table_info(submissions)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  assert.ok(formColumns.has('turnstile_enabled'));
  assert.ok(formColumns.has('spam_score_threshold'));
  assert.ok(submissionColumns.has('spam_score'));
  assert.ok(submissionColumns.has('spam_reasons'));
  assert.ok(submissionColumns.has('turnstile_status'));
  assert.ok(submissionColumns.has('content_hash'));

  db.prepare(
    `INSERT INTO forms
       (id, name, slug, destination_email, destination_emails, api_key_hash, api_key_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('form-id', 'Existing form', 'existing-form', 'owner@example.com', '["owner@example.com"]', 'hash', 'rsk_test');
  const form = db
    .prepare('SELECT turnstile_enabled, spam_score_threshold FROM forms WHERE id = ?')
    .get('form-id') as { turnstile_enabled: number; spam_score_threshold: number };
  assert.deepEqual(form, { turnstile_enabled: 0, spam_score_threshold: 5 });
});
