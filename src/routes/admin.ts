import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppContext } from '../index.js';
import { getDestinationEmails, type DB, type FormRow, type SubmissionRow } from '../db.js';
import {
  clearSessionCookie,
  createSessionToken,
  generateApiKey,
  isAuthenticated,
  passwordMatches,
  setSessionCookie,
} from '../auth.js';
import { readSettings, sendTest, writeSettings, type Settings } from '../mailer.js';

interface PluginOpts {
  ctx: AppContext;
}

const PAGE_SIZE = 25;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function smtpConfigured(settings: Settings): boolean {
  return Boolean(settings.smtp_email && settings.smtp_password);
}

interface FormPublic {
  id: string;
  name: string;
  slug: string;
  destination_email: string;
  destination_emails: string[];
  subject_template: string;
  allowed_origins: string[];
  redirect_url: string | null;
  api_key_prefix: string;
  enabled: boolean;
  created_at: string;
  endpoint: string;
  turnstile_enabled: boolean;
  turnstile_configured: boolean;
  turnstile_site_key: string | null;
  spam_score_threshold: number;
}

function toFormPublic(form: FormRow, baseUrl: string, turnstileSiteKey?: string): FormPublic {
  const destinationEmails = getDestinationEmails(form);
  let origins: string[] = [];
  try {
    origins = JSON.parse(form.allowed_origins) as string[];
  } catch {
    origins = [];
  }
  return {
    id: form.id,
    name: form.name,
    slug: form.slug,
    destination_email: destinationEmails[0]!,
    destination_emails: destinationEmails,
    subject_template: form.subject_template,
    allowed_origins: Array.isArray(origins) ? origins : [],
    redirect_url: form.redirect_url,
    api_key_prefix: form.api_key_prefix,
    enabled: form.enabled === 1,
    created_at: form.created_at,
    endpoint: `${baseUrl.replace(/\/$/, '')}/api/v1/forms/${form.slug}`,
    turnstile_enabled: form.turnstile_enabled === 1,
    turnstile_configured: Boolean(turnstileSiteKey),
    turnstile_site_key: form.turnstile_enabled === 1 ? turnstileSiteKey ?? null : null,
    spam_score_threshold: form.spam_score_threshold,
  };
}

function getForm(db: DB, id: string): FormRow | undefined {
  return db.prepare('SELECT * FROM forms WHERE id = ?').get(id) as FormRow | undefined;
}

export const adminRoutes: FastifyPluginAsync<PluginOpts> = async (app: FastifyInstance, opts) => {
  const { db, config } = opts.ctx;

  // Guard every admin route except login and me.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0];
    if (url === '/api/admin/login' || url === '/api/admin/me') return;
    if (!isAuthenticated(request, config.sessionSecret)) {
      await reply.code(401).send({ ok: false, error: 'Not authenticated.' });
    }
  });

  // --- Auth ---------------------------------------------------------------

  app.post('/api/admin/login', async (request, reply) => {
    const parsed = z.object({ password: z.string() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'Password required.' });
    }
    if (!passwordMatches(parsed.data.password, config.adminPassword)) {
      await sleep(1000); // slow down brute force
      return reply.code(401).send({ ok: false, error: 'Incorrect password.' });
    }
    setSessionCookie(reply, createSessionToken(config.sessionSecret));
    return reply.send({ ok: true, defaultPassword: config.isDefaultPassword });
  });

  app.post('/api/admin/logout', async (_request, reply) => {
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/me', async (request) => {
    const authed = isAuthenticated(request, config.sessionSecret);
    if (!authed) return { authenticated: false };
    return {
      authenticated: true,
      defaultPassword: config.isDefaultPassword,
      smtpConfigured: smtpConfigured(readSettings(db)),
      turnstileConfigured: Boolean(config.turnstileSecretKey),
    };
  });

  // --- Settings -----------------------------------------------------------

  app.get('/api/admin/settings', async () => {
    const s = readSettings(db);
    return {
      smtp_email: s.smtp_email ?? '',
      smtp_password_set: Boolean(s.smtp_password),
      smtp_host: s.smtp_host ?? '',
      smtp_port: s.smtp_port ?? '',
      smtp_secure: s.smtp_secure === 'true' || s.smtp_secure === '1',
      from_email: s.from_email ?? '',
      from_name: s.from_name ?? '',
    };
  });

  app.post('/api/admin/settings', async (request, reply) => {
    const schema = z.object({
      smtp_email: z.string().email().optional(),
      smtp_password: z.string().optional(),
      smtp_host: z.string().optional(),
      smtp_port: z.union([z.string(), z.number()]).optional(),
      smtp_secure: z.boolean().optional(),
      from_email: z.string().trim().email().optional().or(z.literal('')),
      from_name: z.string().max(120).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid settings.' });
    }
    const b = parsed.data;
    const patch: Partial<Record<keyof Settings, string>> = {};
    if (b.smtp_email !== undefined) patch.smtp_email = b.smtp_email;
    // Only overwrite the password when a non-empty value is supplied (write-only field).
    if (b.smtp_password !== undefined && b.smtp_password.length > 0) patch.smtp_password = b.smtp_password;
    if (b.smtp_host !== undefined) patch.smtp_host = b.smtp_host;
    if (b.smtp_port !== undefined) patch.smtp_port = String(b.smtp_port);
    if (b.smtp_secure !== undefined) patch.smtp_secure = b.smtp_secure ? 'true' : 'false';
    if (b.from_email !== undefined) patch.from_email = b.from_email;
    if (b.from_name !== undefined) patch.from_name = b.from_name;
    writeSettings(db, patch);
    return reply.send({ ok: true });
  });

  app.post('/api/admin/settings/test', async (request, reply) => {
    const parsed = z.object({ to: z.string().email().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'Invalid recipient.' });
    }
    const settings = readSettings(db);
    if (!smtpConfigured(settings)) {
      return reply.code(400).send({ ok: false, error: 'Configure SMTP email and password first.' });
    }
    const to = parsed.data.to ?? settings.smtp_email!;
    const result = await sendTest(settings, to);
    if (result.error) {
      return reply.code(502).send({ ok: false, error: result.error });
    }
    return reply.send({ ok: true, messageId: result.messageId });
  });

  // --- Forms --------------------------------------------------------------

  app.get('/api/admin/forms', async () => {
    const rows = db.prepare('SELECT * FROM forms ORDER BY created_at DESC').all() as FormRow[];
    return { forms: rows.map((r) => toFormPublic(r, config.baseUrl, config.turnstileSiteKey)) };
  });

  const emailSchema = z.string().trim().email();
  const formFields = {
    name: z.string().min(1).max(120),
    slug: z.string().max(60).optional(),
    // destination_email remains accepted for backwards-compatible API clients.
    destination_email: emailSchema.optional(),
    destination_emails: z.array(emailSchema).min(1).max(20).optional(),
    subject_template: z.string().max(200).optional(),
    allowed_origins: z.array(z.string()).max(50).optional(),
    redirect_url: z.string().url().optional().or(z.literal('')),
    enabled: z.boolean().optional(),
    turnstile_enabled: z.boolean().optional(),
    spam_score_threshold: z.number().int().min(1).max(20).optional(),
  };
  const formInput = z.object(formFields).refine((body) => body.destination_emails || body.destination_email, {
    message: 'Provide at least one destination email.',
    path: ['destination_emails'],
  });
  const formPatch = z.object(formFields).partial();

  const normalizeDestinations = (values: string[]): string[] => {
    const seen = new Set<string>();
    return values.filter((email) => {
      const key = email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  app.post('/api/admin/forms', async (request, reply) => {
    const parsed = formInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid form.' });
    }
    const b = parsed.data;
    let slug = b.slug && b.slug.length > 0 ? slugify(b.slug) : slugify(b.name);
    if (!slug) slug = nanoid(8).toLowerCase();

    const exists = db.prepare('SELECT 1 FROM forms WHERE slug = ?').get(slug);
    if (exists) {
      return reply.code(409).send({ ok: false, error: `Slug "${slug}" is already in use.` });
    }

    const destinations = normalizeDestinations(b.destination_emails ?? [b.destination_email!]);
    const turnstileEnabled = b.turnstile_enabled ?? Boolean(config.turnstileSecretKey);
    if (turnstileEnabled && !config.turnstileSecretKey) {
      return reply.code(400).send({ ok: false, error: 'Configure Turnstile environment keys before enabling it.' });
    }
    const key = generateApiKey();
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO forms
         (id, name, slug, destination_email, destination_emails, subject_template, allowed_origins, redirect_url,
          api_key_hash, api_key_prefix, enabled, turnstile_enabled, spam_score_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      b.name,
      slug,
      destinations[0]!,
      JSON.stringify(destinations),
      b.subject_template && b.subject_template.length > 0 ? b.subject_template : 'New submission from {{form}}',
      JSON.stringify(b.allowed_origins ?? []),
      b.redirect_url && b.redirect_url.length > 0 ? b.redirect_url : null,
      key.hash,
      key.prefix,
      b.enabled === false ? 0 : 1,
      turnstileEnabled ? 1 : 0,
      b.spam_score_threshold ?? 5,
    );

    const form = getForm(db, id)!;
    return reply.code(201).send({ form: toFormPublic(form, config.baseUrl, config.turnstileSiteKey), api_key: key.key });
  });

  app.get('/api/admin/forms/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const form = getForm(db, id);
    if (!form) return reply.code(404).send({ ok: false, error: 'Form not found.' });
    return { form: toFormPublic(form, config.baseUrl, config.turnstileSiteKey) };
  });

  app.patch('/api/admin/forms/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const form = getForm(db, id);
    if (!form) return reply.code(404).send({ ok: false, error: 'Form not found.' });

    const parsed = formPatch.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid form.' });
    }
    const b = parsed.data;
    if (b.turnstile_enabled === true && form.turnstile_enabled !== 1 && !config.turnstileSecretKey) {
      return reply.code(400).send({ ok: false, error: 'Configure Turnstile environment keys before enabling it.' });
    }

    let slug = form.slug;
    if (b.slug !== undefined) {
      const next = slugify(b.slug);
      if (next && next !== form.slug) {
        const clash = db.prepare('SELECT 1 FROM forms WHERE slug = ? AND id != ?').get(next, id);
        if (clash) return reply.code(409).send({ ok: false, error: `Slug "${next}" is already in use.` });
        slug = next;
      }
    }

    const destinations =
      b.destination_emails !== undefined
        ? normalizeDestinations(b.destination_emails)
        : b.destination_email !== undefined
          ? [b.destination_email]
          : getDestinationEmails(form);

    db.prepare(
      `UPDATE forms SET
         name = ?, slug = ?, destination_email = ?, destination_emails = ?, subject_template = ?,
         allowed_origins = ?, redirect_url = ?, enabled = ?, turnstile_enabled = ?, spam_score_threshold = ?
       WHERE id = ?`,
    ).run(
      b.name ?? form.name,
      slug,
      destinations[0]!,
      JSON.stringify(destinations),
      b.subject_template ?? form.subject_template,
      b.allowed_origins !== undefined ? JSON.stringify(b.allowed_origins) : form.allowed_origins,
      b.redirect_url !== undefined ? (b.redirect_url.length > 0 ? b.redirect_url : null) : form.redirect_url,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : form.enabled,
      b.turnstile_enabled !== undefined ? (b.turnstile_enabled ? 1 : 0) : form.turnstile_enabled,
      b.spam_score_threshold ?? form.spam_score_threshold,
      id,
    );

    return { form: toFormPublic(getForm(db, id)!, config.baseUrl, config.turnstileSiteKey) };
  });

  app.delete('/api/admin/forms/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const info = db.prepare('DELETE FROM forms WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ ok: false, error: 'Form not found.' });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/forms/:id/regenerate-key', async (request, reply) => {
    const { id } = request.params as { id: string };
    const form = getForm(db, id);
    if (!form) return reply.code(404).send({ ok: false, error: 'Form not found.' });
    const key = generateApiKey();
    db.prepare('UPDATE forms SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?').run(key.hash, key.prefix, id);
    return reply.send({ api_key: key.key, api_key_prefix: key.prefix });
  });

  // --- Submissions --------------------------------------------------------

  app.get('/api/admin/submissions', async (request) => {
    const q = z
      .object({
        form_id: z.string().optional(),
        status: z.enum(['sent', 'failed', 'spam', 'rate_limited']).optional(),
        page: z.coerce.number().int().min(1).optional(),
      })
      .parse(request.query);

    const page = q.page ?? 1;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.form_id) {
      where.push('form_id = ?');
      params.push(q.form_id);
    }
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM submissions ${whereSql}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM submissions ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as SubmissionRow[];

    const submissions = rows.map((r) => ({
      ...r,
      payload: safeParse(r.payload),
      spam_reasons: safeParse(r.spam_reasons),
    }));

    return { submissions, page, pageSize: PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  });

  // --- Stats --------------------------------------------------------------

  app.get('/api/admin/stats', async () => {
    const countSince = (status: string, since: string): number =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status = ? AND created_at >= datetime('now', ?)`)
          .get(status, since) as { n: number }
      ).n;

    const perForm = db
      .prepare(
        `SELECT f.id AS form_id, f.name AS form_name, f.slug AS slug,
                SUM(CASE WHEN s.status = 'sent' THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN s.status = 'spam' THEN 1 ELSE 0 END) AS spam,
                COUNT(s.id) AS total
         FROM forms f LEFT JOIN submissions s ON s.form_id = f.id
         GROUP BY f.id ORDER BY f.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
      last24h: {
        sent: countSince('sent', '-1 day'),
        failed: countSince('failed', '-1 day'),
        spam: countSince('spam', '-1 day'),
      },
      last30d: {
        sent: countSince('sent', '-30 days'),
        failed: countSince('failed', '-30 days'),
        spam: countSince('spam', '-30 days'),
      },
      perForm,
    };
  });
};

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
