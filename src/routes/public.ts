import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import cors from '@fastify/cors';
import type { AppContext } from '../index.js';
import { getDestinationEmails, type DB, type FormRow } from '../db.js';
import { hashApiKey } from '../auth.js';
import { readSettings, sendEmail } from '../mailer.js';
import { renderSubmission } from '../emailTemplate.js';

const MAX_FIELDS = 50;
const MAX_VALUE_BYTES = 10 * 1024;

interface PluginOpts {
  ctx: AppContext;
}

type SubmissionStatus = 'sent' | 'failed' | 'spam' | 'rate_limited';

interface LogArgs {
  formId: string;
  payload: Record<string, unknown>;
  replyTo?: string | null;
  status: SubmissionStatus;
  error?: string | null;
  messageId?: string | null;
  ip?: string | null;
}

function logSubmission(db: DB, args: LogArgs): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO submissions (id, form_id, payload, reply_to, status, error, message_id, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.formId,
    JSON.stringify(args.payload),
    args.replyTo ?? null,
    args.status,
    args.error ?? null,
    args.messageId ?? null,
    args.ip ?? null,
  );
  return id;
}

function getFormBySlug(db: DB, slug: string): FormRow | undefined {
  return db.prepare('SELECT * FROM forms WHERE slug = ?').get(slug) as FormRow | undefined;
}

function getFormByKeyHash(db: DB, hash: string): FormRow | undefined {
  return db.prepare('SELECT * FROM forms WHERE api_key_hash = ?').get(hash) as FormRow | undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Enforce the origin allowlist. Empty allowlist = allow all. */
function originAllowed(form: FormRow, request: FastifyRequest): boolean {
  let allowed: string[] = [];
  try {
    allowed = JSON.parse(form.allowed_origins) as string[];
  } catch {
    allowed = [];
  }
  if (!Array.isArray(allowed) || allowed.length === 0) return true;

  const allowedHosts = new Set(allowed.map((o) => hostOf(o) ?? o.toLowerCase()));
  const reqHost = hostOf(request.headers.origin) ?? hostOf(request.headers.referer as string | undefined);
  if (!reqHost) return false;
  return allowedHosts.has(reqHost);
}

/** Collect submitted fields from urlencoded/JSON body or a multipart request. */
async function collectFields(request: FastifyRequest): Promise<{ fields: Record<string, unknown>; error?: string }> {
  if (request.isMultipart()) {
    const fields: Record<string, unknown> = {};
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        // Fields only in v1: drain and discard any file part.
        await part.toBuffer().catch(() => undefined);
        continue;
      }
      fields[part.fieldname] = part.value;
    }
    return { fields };
  }

  const body = request.body;
  if (body === undefined || body === null) return { fields: {} };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { fields: {}, error: 'Body must be an object of fields.' };
  }
  return { fields: { ...(body as Record<string, unknown>) } };
}

/** Validate field count and per-value size. Returns an error string or null. */
function validateFields(fields: Record<string, unknown>): string | null {
  const keys = Object.keys(fields);
  if (keys.length === 0) return 'No fields submitted.';
  if (keys.length > MAX_FIELDS) return `Too many fields (max ${MAX_FIELDS}).`;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      return `Field "${key}" exceeds the ${MAX_VALUE_BYTES / 1024} KB limit.`;
    }
  }
  return null;
}

function applySubjectTemplate(template: string, formName: string, subjectOverride?: string): string {
  return template
    .replace(/\{\{\s*form\s*\}\}/g, formName)
    .replace(/\{\{\s*subject\s*\}\}/g, subjectOverride ?? '');
}

function thanksPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Thanks</title>
    <style>
      body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
             font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
             background:#f3f4f6; color:#111827; }
      .card { background:#fff; padding:40px 48px; border-radius:12px; border:1px solid #e5e7eb;
              text-align:center; max-width:420px; }
      h1 { margin:0 0 8px; font-size:22px; }
      p { margin:0; color:#6b7280; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Thanks!</h1>
      <p>Your message has been sent. You can close this tab.</p>
    </div>
  </body>
</html>`;
}

export const publicRoutes: FastifyPluginAsync<PluginOpts> = async (app: FastifyInstance, opts) => {
  const { db, limiter } = opts.ctx;

  // CORS scoped to this plugin: reflect the requesting origin so browser forms
  // on any site can post. Per-form access control is enforced by the allowlist.
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/v1/forms/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const form = getFormBySlug(db, slug);

    const collected = await collectFields(request);
    const wantsJson = (request.headers['content-type'] ?? '').includes('application/json');

    if (!form || !form.enabled) {
      return reply.code(404).send({ ok: false, error: 'Form not found.' });
    }
    if (collected.error) {
      return reply.code(400).send({ ok: false, error: collected.error });
    }

    const rawFields = collected.fields;
    const ip = request.ip;

    // Honeypot: if _gotcha is filled, silently record spam and fake success.
    const gotcha = rawFields['_gotcha'];
    if (typeof gotcha === 'string' && gotcha.trim().length > 0) {
      logSubmission(db, { formId: form.id, payload: rawFields, status: 'spam', ip });
      return respondSuccess(reply, form.redirect_url, wantsJson, nanoid());
    }

    if (!originAllowed(form, request)) {
      return reply.code(403).send({ ok: false, error: 'Origin not allowed.' });
    }

    if (!limiter.check(`${form.id}:${ip}`)) {
      logSubmission(db, { formId: form.id, payload: rawFields, status: 'rate_limited', ip });
      return reply.code(429).send({ ok: false, error: 'Too many requests. Try again shortly.' });
    }

    // Extract reserved control fields, then build the delivered payload.
    const subjectOverride = typeof rawFields['_subject'] === 'string' ? (rawFields['_subject'] as string) : undefined;
    const replyToRaw =
      (typeof rawFields['_replyto'] === 'string' ? (rawFields['_replyto'] as string) : undefined) ??
      (typeof rawFields['email'] === 'string' ? (rawFields['email'] as string) : undefined);
    const replyTo = replyToRaw && EMAIL_RE.test(replyToRaw.trim()) ? replyToRaw.trim() : undefined;

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawFields)) {
      if (key === '_gotcha' || key === '_subject' || key === '_replyto') continue;
      payload[key] = value;
    }

    const validationError = validateFields(payload);
    if (validationError) {
      return reply.code(400).send({ ok: false, error: validationError });
    }

    const settings = readSettings(db);
    const subject = applySubjectTemplate(form.subject_template, form.name, subjectOverride);
    const { html, text } = renderSubmission(form.name, payload);

    const result = await sendEmail(settings, {
      to: getDestinationEmails(form),
      subject,
      html,
      text,
      replyTo,
    });

    if (result.error) {
      logSubmission(db, { formId: form.id, payload, replyTo, status: 'failed', error: result.error, ip });
      app.log.error({ err: result.error, form: form.slug }, 'form send failed');
      return reply.code(502).send({ ok: false, error: `Email delivery failed: ${result.error}` });
    }

    const id = logSubmission(db, {
      formId: form.id,
      payload,
      replyTo,
      status: 'sent',
      messageId: result.messageId,
      ip,
    });
    return respondSuccess(reply, form.redirect_url, wantsJson, id);
  });

  app.post('/api/v1/send', async (request, reply) => {
    const auth = request.headers.authorization ?? '';
    const match = /^Bearer\s+(rsk_[A-Za-z0-9]+)$/.exec(auth.trim());
    if (!match) {
      return reply.code(401).send({ ok: false, error: 'Missing or malformed API key.' });
    }
    const form = getFormByKeyHash(db, hashApiKey(match[1]));
    if (!form || !form.enabled) {
      return reply.code(401).send({ ok: false, error: 'Invalid API key.' });
    }

    const schema = z
      .object({
        subject: z.string().min(1).max(998),
        html: z.string().max(1_000_000).optional(),
        text: z.string().max(1_000_000).optional(),
        replyTo: z.string().email().optional(),
      })
      .refine((b) => Boolean(b.html) || Boolean(b.text), {
        message: 'Provide at least one of html or text.',
      });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
    }
    const { subject, html, text, replyTo } = parsed.data;

    const settings = readSettings(db);
    const result = await sendEmail(settings, {
      to: getDestinationEmails(form), // recipient is ALWAYS the form's destination
      subject,
      html,
      text,
      replyTo,
    });

    const payload = { subject, html: html ? '[html]' : undefined, text: text ? '[text]' : undefined };
    if (result.error) {
      logSubmission(db, { formId: form.id, payload, replyTo, status: 'failed', error: result.error, ip: request.ip });
      app.log.error({ err: result.error, form: form.slug }, 'api send failed');
      return reply.code(502).send({ ok: false, error: `Email delivery failed: ${result.error}` });
    }
    const id = logSubmission(db, {
      formId: form.id,
      payload,
      replyTo,
      status: 'sent',
      messageId: result.messageId,
      ip: request.ip,
    });
    return reply.code(200).send({ ok: true, id });
  });
};

function respondSuccess(reply: FastifyReply, redirectUrl: string | null, wantsJson: boolean, id: string): FastifyReply {
  if (wantsJson) {
    return reply.code(200).send({ ok: true, id });
  }
  if (redirectUrl) {
    return reply.code(302).redirect(redirectUrl);
  }
  return reply.code(200).type('text/html').send(thanksPage());
}
