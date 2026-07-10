import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface Config {
  port: number;
  dataDir: string;
  adminPassword: string;
  isDefaultPassword: boolean;
  sessionSecret: string;
  baseUrl: string;
  trustProxy: boolean;
  dbPath: string;
}

const DEFAULT_PASSWORD = 'admin';

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Resolve the session secret. Precedence:
 *   1. SESSION_SECRET env var
 *   2. A previously generated secret persisted at $DATA_DIR/secret
 *   3. A freshly generated secret, persisted for next boot
 */
function resolveSessionSecret(dataDir: string): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const secretPath = join(dataDir, 'secret');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length > 0) return existing;
  }

  const generated = randomBytes(32).toString('hex');
  writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

export function loadConfig(): Config {
  const dataDirRaw = process.env.DATA_DIR ?? './data';
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : resolve(process.cwd(), dataDirRaw);
  mkdirSync(dataDir, { recursive: true });

  const adminPassword = process.env.ADMIN_PASSWORD ?? DEFAULT_PASSWORD;

  return {
    port: Number(process.env.PORT ?? 3000),
    dataDir,
    adminPassword,
    isDefaultPassword: adminPassword === DEFAULT_PASSWORD,
    sessionSecret: resolveSessionSecret(dataDir),
    baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',
    trustProxy: parseBool(process.env.TRUST_PROXY, false),
    dbPath: join(dataDir, 'resender.db'),
  };
}
