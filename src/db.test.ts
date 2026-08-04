import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openDb } from './db.js';

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
