import Database from 'better-sqlite3';

export type DB = Database.Database;

export interface FormRow {
  id: string;
  name: string;
  slug: string;
  destination_email: string;
  destination_emails: string;
  subject_template: string;
  allowed_origins: string;
  redirect_url: string | null;
  api_key_hash: string;
  api_key_prefix: string;
  enabled: number;
  turnstile_enabled: number;
  spam_score_threshold: number;
  sms_enabled: number;
  sms_number: string | null;
  sms_template: string;
  sms_device_id: string | null;
  created_at: string;
}

export interface SmsDeviceRow {
  id: string;
  name: string;
  api_key_hash: string;
  api_key_prefix: string;
  fcm_token: string | null;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  build_id: string | null;
  os: string | null;
  os_version: string | null;
  app_version_name: string | null;
  app_version_code: number | null;
  enabled: number;
  is_default: number;
  registered_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export type SmsDirection = 'outbound' | 'inbound';

export interface SmsMessageRow {
  id: string;
  device_id: string | null;
  direction: SmsDirection;
  recipient: string | null;
  sender: string | null;
  message: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  form_id: string | null;
  submission_id: string | null;
  requested_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  received_at: string | null;
  created_at: string;
}

/** Default per-form SMS template. Any submitted field can be referenced as {{field_name}}. */
export const DEFAULT_SMS_TEMPLATE = 'New {{form}} submission from {{name}} {{email}} {{phone}}: {{message}}';

export interface SubmissionRow {
  id: string;
  form_id: string;
  payload: string;
  reply_to: string | null;
  status: string;
  error: string | null;
  message_id: string | null;
  ip: string | null;
  spam_score: number;
  spam_reasons: string;
  turnstile_status: string | null;
  content_hash: string | null;
  sms_status: string | null;
  sms_error: string | null;
  sms_message_id: string | null;
  created_at: string;
}

interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE forms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          destination_email TEXT NOT NULL,
          subject_template TEXT NOT NULL DEFAULT 'New submission from {{form}}',
          allowed_origins TEXT NOT NULL DEFAULT '[]',
          redirect_url TEXT,
          api_key_hash TEXT NOT NULL,
          api_key_prefix TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE submissions (
          id TEXT PRIMARY KEY,
          form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
          payload TEXT NOT NULL,
          reply_to TEXT,
          status TEXT NOT NULL,
          error TEXT,
          message_id TEXT,
          ip TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_submissions_form_created
          ON submissions(form_id, created_at DESC);
      `);
    },
  },
  {
    version: 2,
    name: 'multiple destination emails',
    up(db) {
      db.exec(`ALTER TABLE forms ADD COLUMN destination_emails TEXT NOT NULL DEFAULT '[]'`);
      const rows = db.prepare('SELECT id, destination_email FROM forms').all() as Array<{
        id: string;
        destination_email: string;
      }>;
      const update = db.prepare('UPDATE forms SET destination_emails = ? WHERE id = ?');
      for (const row of rows) {
        update.run(JSON.stringify([row.destination_email]), row.id);
      }
    },
  },
  {
    version: 3,
    name: 'turnstile and spam scoring',
    up(db) {
      // Existing forms remain compatible until Turnstile is explicitly enabled.
      db.exec(`
        ALTER TABLE forms ADD COLUMN turnstile_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE forms ADD COLUMN spam_score_threshold INTEGER NOT NULL DEFAULT 5;
        ALTER TABLE submissions ADD COLUMN spam_score INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE submissions ADD COLUMN spam_reasons TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE submissions ADD COLUMN turnstile_status TEXT;
        ALTER TABLE submissions ADD COLUMN content_hash TEXT;
        CREATE INDEX idx_submissions_content_hash_created
          ON submissions(form_id, content_hash, created_at DESC);
      `);
    },
  },
  {
    version: 4,
    name: 'sms gateway',
    up(db) {
      // SMS is opt-in per form; existing forms keep sms_enabled = 0.
      db.prepare(`ALTER TABLE forms ADD COLUMN sms_enabled INTEGER NOT NULL DEFAULT 0`).run();
      db.prepare(`ALTER TABLE forms ADD COLUMN sms_number TEXT`).run();
      // DDL cannot take bound parameters; the default is a constant without quotes to escape.
      db.exec(`ALTER TABLE forms ADD COLUMN sms_template TEXT NOT NULL DEFAULT '${DEFAULT_SMS_TEMPLATE.replace(/'/g, "''")}'`);
      db.exec(`
        ALTER TABLE forms ADD COLUMN sms_device_id TEXT;
        ALTER TABLE submissions ADD COLUMN sms_status TEXT;
        ALTER TABLE submissions ADD COLUMN sms_error TEXT;
        ALTER TABLE submissions ADD COLUMN sms_message_id TEXT;

        CREATE TABLE sms_devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          api_key_hash TEXT NOT NULL UNIQUE,
          api_key_prefix TEXT NOT NULL,
          fcm_token TEXT,
          brand TEXT,
          manufacturer TEXT,
          model TEXT,
          build_id TEXT,
          os TEXT,
          os_version TEXT,
          app_version_name TEXT,
          app_version_code INTEGER,
          enabled INTEGER NOT NULL DEFAULT 1,
          is_default INTEGER NOT NULL DEFAULT 0,
          registered_at TEXT,
          last_seen_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE sms_messages (
          id TEXT PRIMARY KEY,
          device_id TEXT REFERENCES sms_devices(id) ON DELETE SET NULL,
          direction TEXT NOT NULL,
          recipient TEXT,
          sender TEXT,
          message TEXT NOT NULL,
          status TEXT NOT NULL,
          error_code TEXT,
          error_message TEXT,
          form_id TEXT,
          submission_id TEXT,
          requested_at TEXT,
          sent_at TEXT,
          delivered_at TEXT,
          failed_at TEXT,
          received_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_sms_messages_created ON sms_messages(created_at DESC);
        CREATE INDEX idx_sms_messages_submission ON sms_messages(submission_id);
        CREATE INDEX idx_sms_messages_device_created ON sms_messages(device_id, created_at DESC);
      `);
    },
  },
];

/** Read the recipient list, falling back to the legacy single-address column. */
export function getDestinationEmails(form: FormRow): string[] {
  try {
    const parsed = JSON.parse(form.destination_emails) as unknown;
    if (Array.isArray(parsed)) {
      const emails = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
      if (emails.length > 0) return emails;
    }
  } catch {
    // Fall through to the legacy column for pre-migration or malformed rows.
  }
  return [form.destination_email];
}

/**
 * Open the SQLite database, apply pragmas, and run any pending numbered
 * migrations inside a transaction. Migrations are tracked in a
 * `schema_migrations` table so each runs exactly once.
 */
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name);
    });
    run();
  }

  return db;
}
