import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppContext } from '../index.js';
import {
  DEFAULT_SMS_TEMPLATE,
  getDestinationEmails,
  type DB,
  type FormRow,
  type SmsDeviceRow,
  type SmsMessageRow,
  type SubmissionRow,
} from '../db.js';
import {
  countRegisteredDevices,
  generateDeviceKey,
  getDevice,
  getMessage,
  getSmsConfig,
  listDevices,
  sendSms,
  smsReady,
} from '../sms/gateway.js';
import { clearTokenCache, parseServiceAccount } from '../sms/fcm.js';
import { normalizeCountryCode, normalizePhone } from '../sms/phone.js';
import { clampMaxLength } from '../sms/template.js';
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
  sms_enabled: boolean;
  sms_number: string | null;
  sms_template: string;
  sms_device_id: string | null;
}

interface DevicePublic {
  id: string;
  name: string;
  api_key_prefix: string;
  registered: boolean;
  connected: boolean;
  enabled: boolean;
  is_default: boolean;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  os_version: string | null;
  app_version_name: string | null;
  registered_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

function toDevicePublic(d: SmsDeviceRow): DevicePublic {
  return {
    id: d.id,
    name: d.name,
    api_key_prefix: d.api_key_prefix,
    registered: Boolean(d.registered_at),
    connected: Boolean(d.fcm_token),
    enabled: d.enabled === 1,
    is_default: d.is_default === 1,
    brand: d.brand,
    manufacturer: d.manufacturer,
    model: d.model,
    os_version: d.os_version,
    app_version_name: d.app_version_name,
    registered_at: d.registered_at,
    last_seen_at: d.last_seen_at,
    created_at: d.created_at,
  };
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
    sms_enabled: form.sms_enabled === 1,
    sms_number: form.sms_number,
    sms_template: form.sms_template,
    sms_device_id: form.sms_device_id,
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
      smsConfigured: smsReady(db),
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
    sms_enabled: z.boolean().optional(),
    sms_number: z.string().max(40).optional(),
    sms_template: z.string().max(1000).optional(),
    sms_device_id: z.string().max(40).nullable().optional(),
  };

  interface SmsFieldsInput {
    sms_enabled?: boolean;
    sms_number?: string;
    sms_template?: string;
    sms_device_id?: string | null;
  }
  interface SmsFields {
    enabled: number;
    number: string | null;
    template: string;
    deviceId: string | null;
  }

  /** Validate/normalize the per-form SMS fields, merging over the current row on PATCH. */
  const resolveSmsFields = (b: SmsFieldsInput, current?: FormRow): SmsFields | { error: string } => {
    let number: string | null = current?.sms_number ?? null;
    if (b.sms_number !== undefined) {
      const trimmed = b.sms_number.trim();
      if (trimmed.length === 0) {
        number = null;
      } else {
        const normalized = normalizePhone(trimmed, getSmsConfig(db).defaultCountryCode);
        if (!normalized) return { error: `"${trimmed}" is not a valid mobile number.` };
        number = normalized;
      }
    }
    const enabled = b.sms_enabled ?? (current ? current.sms_enabled === 1 : false);
    if (enabled && !number) return { error: 'Enter a mobile number to enable SMS notifications.' };

    let template = current?.sms_template ?? DEFAULT_SMS_TEMPLATE;
    if (b.sms_template !== undefined) {
      template = b.sms_template.trim().length > 0 ? b.sms_template.trim() : DEFAULT_SMS_TEMPLATE;
    }

    let deviceId: string | null = current?.sms_device_id ?? null;
    if (b.sms_device_id !== undefined) {
      if (!b.sms_device_id) deviceId = null;
      else if (!getDevice(db, b.sms_device_id)) return { error: 'The selected phone no longer exists.' };
      else deviceId = b.sms_device_id;
    }
    return { enabled: enabled ? 1 : 0, number, template, deviceId };
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
    const sms = resolveSmsFields(b);
    if ('error' in sms) return reply.code(400).send({ ok: false, error: sms.error });

    const key = generateApiKey();
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO forms
         (id, name, slug, destination_email, destination_emails, subject_template, allowed_origins, redirect_url,
          api_key_hash, api_key_prefix, enabled, turnstile_enabled, spam_score_threshold,
          sms_enabled, sms_number, sms_template, sms_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      sms.enabled,
      sms.number,
      sms.template,
      sms.deviceId,
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

    const sms = resolveSmsFields(b, form);
    if ('error' in sms) return reply.code(400).send({ ok: false, error: sms.error });

    db.prepare(
      `UPDATE forms SET
         name = ?, slug = ?, destination_email = ?, destination_emails = ?, subject_template = ?,
         allowed_origins = ?, redirect_url = ?, enabled = ?, turnstile_enabled = ?, spam_score_threshold = ?,
         sms_enabled = ?, sms_number = ?, sms_template = ?, sms_device_id = ?
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
      sms.enabled,
      sms.number,
      sms.template,
      sms.deviceId,
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

  // --- SMS gateway --------------------------------------------------------

  app.get('/api/admin/sms/settings', async () => {
    const sms = getSmsConfig(db);
    return {
      firebase_configured: Boolean(sms.serviceAccount),
      firebase_error: sms.serviceAccountError ?? null,
      firebase_project_id: sms.serviceAccount?.project_id ?? null,
      firebase_client_email: sms.serviceAccount?.client_email ?? null,
      default_country_code: sms.defaultCountryCode,
      max_length: sms.maxLength,
      devices_registered: countRegisteredDevices(db),
      ready: smsReady(db),
    };
  });

  app.post('/api/admin/sms/settings', async (request, reply) => {
    const schema = z.object({
      service_account_json: z.string().max(20_000).optional(),
      default_country_code: z.string().max(10).optional(),
      max_length: z.number().optional(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid settings.' });
    }
    const b = parsed.data;
    const patch: Partial<Record<keyof Settings, string>> = {};
    if (b.service_account_json !== undefined && b.service_account_json.trim().length > 0) {
      try {
        const sa = parseServiceAccount(b.service_account_json);
        // Store a compact, validated copy rather than whatever was pasted.
        patch.fcm_service_account = JSON.stringify({
          type: 'service_account',
          project_id: sa.project_id,
          private_key: sa.private_key,
          client_email: sa.client_email,
          token_uri: sa.token_uri,
        });
      } catch (err) {
        return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'Invalid service account.' });
      }
    }
    if (b.default_country_code !== undefined) {
      const cc = normalizeCountryCode(b.default_country_code);
      if (!cc) return reply.code(400).send({ ok: false, error: 'Country code must be 1–3 digits, e.g. +61.' });
      patch.sms_default_country_code = cc;
    }
    if (b.max_length !== undefined) patch.sms_max_length = String(clampMaxLength(b.max_length));
    writeSettings(db, patch);
    if (patch.fcm_service_account) clearTokenCache();
    return reply.send({ ok: true });
  });

  app.delete('/api/admin/sms/settings/firebase', async (_request, reply) => {
    writeSettings(db, { fcm_service_account: '' });
    clearTokenCache();
    return reply.send({ ok: true });
  });

  app.get('/api/admin/sms/devices', async () => ({ devices: listDevices(db).map(toDevicePublic) }));

  app.post('/api/admin/sms/devices', async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Give the phone a name.' });
    const key = generateDeviceKey();
    const id = nanoid(12);
    const isFirst = (db.prepare('SELECT COUNT(*) AS n FROM sms_devices').get() as { n: number }).n === 0;
    db.prepare(
      `INSERT INTO sms_devices (id, name, api_key_hash, api_key_prefix, is_default) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, parsed.data.name, key.hash, key.prefix, isFirst ? 1 : 0);
    return reply.code(201).send({ device: toDevicePublic(getDevice(db, id)!), api_key: key.key });
  });

  app.patch('/api/admin/sms/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = getDevice(db, id);
    if (!device) return reply.code(404).send({ ok: false, error: 'Phone not found.' });
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        is_default: z.boolean().optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Invalid phone update.' });
    const b = parsed.data;
    const tx = db.transaction(() => {
      if (b.is_default === true) db.prepare('UPDATE sms_devices SET is_default = 0').run();
      db.prepare('UPDATE sms_devices SET name = ?, enabled = ?, is_default = ? WHERE id = ?').run(
        b.name ?? device.name,
        b.enabled !== undefined ? (b.enabled ? 1 : 0) : device.enabled,
        b.is_default !== undefined ? (b.is_default ? 1 : 0) : device.is_default,
        id,
      );
    });
    tx();
    return { device: toDevicePublic(getDevice(db, id)!) };
  });

  app.delete('/api/admin/sms/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tx = db.transaction(() => {
      db.prepare('UPDATE forms SET sms_device_id = NULL WHERE sms_device_id = ?').run(id);
      return db.prepare('DELETE FROM sms_devices WHERE id = ?').run(id).changes;
    });
    if (tx() === 0) return reply.code(404).send({ ok: false, error: 'Phone not found.' });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/sms/devices/:id/regenerate-key', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getDevice(db, id)) return reply.code(404).send({ ok: false, error: 'Phone not found.' });
    const key = generateDeviceKey();
    // A new key means the app must re-register, so drop the stale push token.
    db.prepare(
      'UPDATE sms_devices SET api_key_hash = ?, api_key_prefix = ?, fcm_token = NULL, registered_at = NULL WHERE id = ?',
    ).run(key.hash, key.prefix, id);
    return reply.send({ api_key: key.key, api_key_prefix: key.prefix, device: toDevicePublic(getDevice(db, id)!) });
  });

  app.post('/api/admin/sms/test', async (request, reply) => {
    const parsed = z
      .object({ to: z.string().trim().min(1).max(40), device_id: z.string().optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Enter a mobile number.' });
    const to = normalizePhone(parsed.data.to, getSmsConfig(db).defaultCountryCode);
    if (!to) return reply.code(400).send({ ok: false, error: `"${parsed.data.to}" is not a valid mobile number.` });
    const result = await sendSms(db, {
      to,
      message: 'resender test SMS: your phone gateway is working.',
      deviceId: parsed.data.device_id ?? null,
    });
    if (result.error) return reply.code(502).send({ ok: false, id: result.id, status: result.status, error: result.error });
    return reply.send({ ok: true, id: result.id, status: result.status, to });
  });

  const toMessagePublic = (m: SmsMessageRow & { device_name?: string | null; form_name?: string | null }) => ({
    id: m.id,
    device_id: m.device_id,
    device_name: m.device_name ?? null,
    direction: m.direction,
    recipient: m.recipient,
    sender: m.sender,
    message: m.message,
    status: m.status,
    error_code: m.error_code,
    error_message: m.error_message,
    form_id: m.form_id,
    form_name: m.form_name ?? null,
    submission_id: m.submission_id,
    requested_at: m.requested_at,
    sent_at: m.sent_at,
    delivered_at: m.delivered_at,
    failed_at: m.failed_at,
    received_at: m.received_at,
    created_at: m.created_at,
  });

  const messageSelect = `SELECT m.*, d.name AS device_name, f.name AS form_name
     FROM sms_messages m
     LEFT JOIN sms_devices d ON d.id = m.device_id
     LEFT JOIN forms f ON f.id = m.form_id`;

  app.get('/api/admin/sms/messages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getMessage(db, id)) return reply.code(404).send({ ok: false, error: 'Message not found.' });
    const row = db.prepare(`${messageSelect} WHERE m.id = ?`).get(id) as SmsMessageRow & {
      device_name: string | null;
      form_name: string | null;
    };
    return { message: toMessagePublic(row) };
  });

  app.get('/api/admin/sms/messages', async (request) => {
    const q = z
      .object({
        direction: z.enum(['outbound', 'inbound']).optional(),
        status: z.string().max(30).optional(),
        device_id: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
      })
      .parse(request.query);
    const page = q.page ?? 1;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.direction) {
      where.push('m.direction = ?');
      params.push(q.direction);
    }
    if (q.status) {
      where.push('m.status = ?');
      params.push(q.status);
    }
    if (q.device_id) {
      where.push('m.device_id = ?');
      params.push(q.device_id);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM sms_messages m ${whereSql}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`${messageSelect} ${whereSql} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Array<
      SmsMessageRow & { device_name: string | null; form_name: string | null }
    >;
    return {
      messages: rows.map(toMessagePublic),
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
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
