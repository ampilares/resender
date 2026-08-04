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
  created_at: string;
}

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
