import nodemailer, { type Transporter } from 'nodemailer';
import type { DB } from './db.js';

export interface Settings {
  smtp_email?: string;
  smtp_password?: string;
  smtp_host?: string;
  smtp_port?: string;
  smtp_secure?: string;
  from_name?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
}

export interface SendArgs {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
}

export interface SendResult {
  messageId?: string;
  error?: string;
}

/** Read all rows from the settings key/value table into a typed object. */
export function readSettings(db: DB): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Settings = {};
  for (const { key, value } of rows) {
    out[key as keyof Settings] = value;
  }
  return out;
}

/** Upsert a partial set of settings. `undefined` values are skipped; empty string clears. */
export function writeSettings(db: DB, patch: Partial<Record<keyof Settings, string>>): void {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      stmt.run(key, value);
    }
  });
  tx();
}

/**
 * Detect SMTP host/port/secure from the email domain. Adapted from the maildrop
 * reference, minus its ProtonMail 127.0.0.1 entry. Returns null for unknown
 * domains so callers can require an explicit custom SMTP configuration rather
 * than silently defaulting to Gmail.
 */
export function detectSmtpConfig(email: string): SmtpConfig | null {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { host: 'smtp.gmail.com', port: 587, secure: false };
  }
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') {
    return { host: 'smtp-mail.outlook.com', port: 587, secure: false };
  }
  if (domain === 'yahoo.com' || domain === 'yahoo.co.uk' || domain === 'ymail.com') {
    return { host: 'smtp.mail.yahoo.com', port: 587, secure: false };
  }
  if (domain === 'zoho.com' || domain.endsWith('.zoho.com')) {
    return { host: 'smtp.zoho.com', port: 587, secure: false };
  }
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') {
    return { host: 'smtp.mail.me.com', port: 587, secure: false };
  }
  return null;
}

/**
 * Resolve the effective SMTP configuration from settings: a fully custom host
 * override takes precedence, otherwise the host is auto-detected from the email
 * domain. Throws a clear error if neither is available.
 */
export function resolveSmtpConfig(settings: Settings): SmtpConfig {
  const email = settings.smtp_email;
  if (!email) throw new Error('SMTP not configured: set the sender email in Settings.');

  if (settings.smtp_host && settings.smtp_host.length > 0) {
    const port = settings.smtp_port ? Number(settings.smtp_port) : 587;
    const secure = settings.smtp_secure === 'true' || settings.smtp_secure === '1' || port === 465;
    return { host: settings.smtp_host, port, secure };
  }

  const detected = detectSmtpConfig(email);
  if (!detected) {
    throw new Error(
      `SMTP not configured: could not auto-detect settings for "${email}". Configure a custom SMTP host/port in Settings.`,
    );
  }
  return detected;
}

/** Build a nodemailer transport lazily from the current settings. */
export function buildTransport(settings: Settings): Transporter {
  if (!settings.smtp_email || !settings.smtp_password) {
    throw new Error('SMTP not configured: sender email and password are required.');
  }
  const cfg = resolveSmtpConfig(settings);
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: settings.smtp_email, pass: settings.smtp_password },
  });
}

/** Compose the RFC 5322 From header from settings. */
export function fromHeader(settings: Settings): string {
  const email = settings.smtp_email ?? '';
  const name = settings.from_name?.trim();
  return name ? `"${name.replace(/"/g, '')}" <${email}>` : email;
}

/**
 * Send one email. Returns { messageId } on success or { error } on failure —
 * never throws, so callers can log a `failed` submission and return 502.
 */
export async function sendEmail(settings: Settings, args: SendArgs): Promise<SendResult> {
  let transport: Transporter;
  try {
    transport = buildTransport(settings);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const info = await transport.sendMail({
      from: fromHeader(settings),
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
    });
    return { messageId: info.messageId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify SMTP connectivity by sending a test email. */
export async function sendTest(settings: Settings, to: string): Promise<SendResult> {
  return sendEmail(settings, {
    to,
    subject: 'resender test email',
    text: 'This is a test email from resender. If you received it, your SMTP settings work.',
    html: '<p>This is a test email from <strong>resender</strong>. If you received it, your SMTP settings work.</p>',
  });
}
