import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import cors from '@fastify/cors';
import type { AppContext } from '../index.js';
import { getDestinationEmails, type DB, type FormRow } from '../db.js';
import { hashApiKey } from '../auth.js';
import { readSettings, sendEmail } from '../mailer.js';
import { renderSubmission } from '../emailTemplate.js';
import { scoreSubmission, submissionFingerprint, type SpamHistory, type SpamReason } from '../spamScoring.js';
import { verifyTurnstile } from '../turnstile.js';
import { getSmsConfig, sendSms, type SendSmsResult } from '../sms/gateway.js';
import { renderSmsTemplate } from '../sms/template.js';

const MAX_FIELDS = 50;
const MAX_VALUE_BYTES = 10 * 1024;

interface PluginOpts {
  ctx: AppContext;
}

type SubmissionStatus = 'sent' | 'failed' | 'spam' | 'rate_limited';

interface LogArgs {
  /** Pre-generated id so related rows (e.g. an SMS) can reference the submission. */
  id?: string;
  formId: string;
  payload: Record<string, unknown>;
  replyTo?: string | null;
  status: SubmissionStatus;
  error?: string | null;
  messageId?: string | null;
  ip?: string | null;
  spamScore?: number;
  spamReasons?: SpamReason[];
  turnstileStatus?: string | null;
  contentHash?: string | null;
  sms?: SendSmsResult;
}

function logSubmission(db: DB, args: LogArgs): string {
  const id = args.id ?? nanoid();
  db.prepare(
    `INSERT INTO submissions
       (id, form_id, payload, reply_to, status, error, message_id, ip, spam_score, spam_reasons, turnstile_status, content_hash,
        sms_status, sms_error, sms_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.formId,
    JSON.stringify(args.payload),
    args.replyTo ?? null,
    args.status,
    args.error ?? null,
    args.messageId ?? null,
    args.ip ?? null,
    args.spamScore ?? 0,
    JSON.stringify(args.spamReasons ?? []),
    args.turnstileStatus ?? null,
    args.contentHash ?? null,
    args.sms?.status ?? null,
    args.sms?.error ?? null,
    args.sms?.id ?? null,
  );
  return id;
}

/**
 * Send the per-form SMS notification for a submission that passed every
 * check. Independent of the email outcome: a failure is recorded on the
 * submission but never changes the HTTP response.
 */
async function notifyBySms(
  app: FastifyInstance,
  db: DB,
  form: FormRow,
  submissionId: string,
  payload: Record<string, unknown>,
): Promise<SendSmsResult | undefined> {
  if (form.sms_enabled !== 1 || !form.sms_number) return undefined;
  const { maxLength } = getSmsConfig(db);
  const message = renderSmsTemplate(form.sms_template, { formName: form.name, fields: payload, maxLength });
  const result = await sendSms(db, {
    to: form.sms_number,
    message,
    formId: form.id,
    submissionId,
    deviceId: form.sms_device_id,
  });
  if (result.error) {
    app.log.warn({ err: result.error, form: form.slug }, 'form sms failed');
  }
  return result;
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

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function getSpamHistory(db: DB, formId: string, ip: string, replyTo: string | undefined, fingerprint: string): SpamHistory {
  const duplicate = db
    .prepare(
      `SELECT ip FROM submissions
       WHERE form_id = ? AND content_hash = ? AND created_at >= datetime('now', '-1 day')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(formId, fingerprint) as { ip: string | null } | undefined;
  const recentFromIp = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE form_id = ? AND ip = ? AND created_at >= datetime('now', '-1 day')`)
      .get(formId, ip) as { n: number }
  ).n;
  const recentFromSender = replyTo
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM submissions
             WHERE form_id = ? AND lower(reply_to) = lower(?) AND created_at >= datetime('now', '-1 hour')`,
          )
          .get(formId, replyTo) as { n: number }
      ).n
    : 0;
  return {
    duplicateFromIp: duplicate?.ip === ip,
    duplicateAcrossIps: Boolean(duplicate && duplicate.ip !== ip),
    recentFromIp,
    recentFromSender,
  };
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

    // Extract control fields early so CAPTCHA tokens and timing metadata are
    // never persisted in logs or forwarded by email.
    const subjectOverride = typeof rawFields['_subject'] === 'string' ? rawFields['_subject'] : undefined;
    const replyToRaw =
      (typeof rawFields['_replyto'] === 'string' ? rawFields['_replyto'] : undefined) ??
      (typeof rawFields['email'] === 'string' ? rawFields['email'] : undefined);
    const replyTo = replyToRaw && EMAIL_RE.test(replyToRaw.trim()) ? replyToRaw.trim() : undefined;
    const turnstileToken =
      typeof rawFields['cf-turnstile-response'] === 'string' ? rawFields['cf-turnstile-response'] : undefined;
    const formStartedAt = typeof rawFields['_form_started_at'] === 'string' ? rawFields['_form_started_at'] : undefined;

    const reservedFields = new Set([
      '_gotcha',
      '_subject',
      '_replyto',
      '_form_started_at',
      'cf-turnstile-response',
      'g-recaptcha-response',
      'h-captcha-response',
    ]);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawFields)) {
      if (!reservedFields.has(key)) payload[key] = value;
    }

    // Honeypot: if _gotcha is filled, silently record spam and fake success.
    const gotcha = rawFields['_gotcha'];
    if (typeof gotcha === 'string' && gotcha.trim().length > 0) {
      logSubmission(db, {
        formId: form.id,
        payload,
        replyTo,
        status: 'spam',
        ip,
        spamScore: 100,
        spamReasons: [{ code: 'honeypot', points: 100, detail: 'Honeypot field was filled' }],
        turnstileStatus: 'not_checked',
        contentHash: submissionFingerprint(payload),
      });
      return respondSuccess(reply, form.redirect_url, wantsJson, nanoid());
    }

    if (!originAllowed(form, request)) {
      return reply.code(403).send({ ok: false, error: 'Origin not allowed.' });
    }

    if (!limiter.check(`${form.id}:${ip}`)) {
      logSubmission(db, { formId: form.id, payload, replyTo, status: 'rate_limited', ip });
      return reply.code(429).send({ ok: false, error: 'Too many requests. Try again shortly.' });
    }

    const validationError = validateFields(payload);
    if (validationError) {
      return reply.code(400).send({ ok: false, error: validationError });
    }

    let turnstileStatus = 'disabled';
    if (form.turnstile_enabled === 1) {
      if (!opts.ctx.config.turnstileSecretKey) {
        logSubmission(db, {
          formId: form.id,
          payload,
          replyTo,
          status: 'failed',
          error: 'Turnstile is enabled for this form but server keys are not configured.',
          ip,
          turnstileStatus: 'misconfigured',
        });
        return reply.code(503).send({ ok: false, error: 'Human verification is temporarily unavailable.' });
      }

      const expectedHostname =
        hostnameOf(request.headers.origin) ?? hostnameOf(request.headers.referer as string | undefined);
      const verification = await verifyTurnstile({
        secretKey: opts.ctx.config.turnstileSecretKey,
        token: turnstileToken,
        remoteIp: ip,
        expectedHostname,
        expectedAction: 'resender_form',
      });
      if (!verification.success) {
        turnstileStatus = verification.unavailable ? 'unavailable' : 'failed';
        const detail = verification.errors.join(', ') || 'unknown validation error';
        logSubmission(db, {
          formId: form.id,
          payload,
          replyTo,
          status: verification.unavailable ? 'failed' : 'spam',
          error: verification.unavailable ? 'Turnstile Siteverify unavailable.' : null,
          ip,
          spamScore: verification.unavailable ? 0 : 100,
          spamReasons: [{ code: 'turnstile_failed', points: verification.unavailable ? 0 : 100, detail }],
          turnstileStatus,
          contentHash: submissionFingerprint(payload),
        });
        if (verification.unavailable) {
          app.log.warn({ errors: verification.errors, form: form.slug }, 'turnstile verification unavailable');
          return reply.code(503).send({ ok: false, error: 'Human verification is temporarily unavailable.' });
        }
        return reply.code(400).send({ ok: false, error: 'Human verification failed. Please try again.' });
      }
      turnstileStatus = 'passed';
    }

    const fingerprint = submissionFingerprint(payload);
    const history = getSpamHistory(db, form.id, ip, replyTo, fingerprint);
    const spam = scoreSubmission({
      fields: payload,
      replyTo,
      userAgent: request.headers['user-agent'],
      formStartedAt,
      history,
    });
    if (spam.score >= form.spam_score_threshold) {
      logSubmission(db, {
        formId: form.id,
        payload,
        replyTo,
        status: 'spam',
        ip,
        spamScore: spam.score,
        spamReasons: spam.reasons,
        turnstileStatus,
        contentHash: spam.fingerprint,
      });
      return respondSuccess(reply, form.redirect_url, wantsJson, nanoid());
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

    const submissionId = nanoid();
    const sms = await notifyBySms(app, db, form, submissionId, payload);

    if (result.error) {
      logSubmission(db, {
        id: submissionId,
        formId: form.id,
        payload,
        replyTo,
        status: 'failed',
        error: result.error,
        ip,
        spamScore: spam.score,
        spamReasons: spam.reasons,
        turnstileStatus,
        contentHash: spam.fingerprint,
        sms,
      });
      app.log.error({ err: result.error, form: form.slug }, 'form send failed');
      return reply.code(502).send({ ok: false, error: `Email delivery failed: ${result.error}` });
    }

    const id = logSubmission(db, {
      id: submissionId,
      formId: form.id,
      payload,
      replyTo,
      status: 'sent',
      messageId: result.messageId,
      ip,
      spamScore: spam.score,
      spamReasons: spam.reasons,
      turnstileStatus,
      contentHash: spam.fingerprint,
      sms,
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
