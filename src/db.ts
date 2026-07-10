import Database from 'better-sqlite3';

export type DB = Database.Database;

export interface FormRow {
  id: string;
  name: string;
  slug: string;
  destination_email: string;
  subject_template: string;
  allowed_origins: string;
  redirect_url: string | null;
  api_key_hash: string;
  api_key_prefix: string;
  enabled: number;
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
];

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
