import { customAlphabet } from 'nanoid';
import { nanoid } from 'nanoid';
import type { DB, SmsDeviceRow, SmsMessageRow } from '../db.js';
import { hashApiKey, type GeneratedKey } from '../auth.js';
import { readSettings } from '../mailer.js';
import { parseServiceAccount, sendDataMessage, type FcmOptions, type ServiceAccount } from './fcm.js';
import { clampMaxLength, DEFAULT_SMS_MAX_LENGTH } from './template.js';
import { normalizeCountryCode } from './phone.js';

/**
 * SMS gateway service. resender acts as the backend for the selfhostsim
 * Android app: outbound messages are pushed to the phone over FCM as a data
 * message, the phone sends the carrier SMS and reports status back through
 * the gateway routes (see routes/gateway.ts).
 */

export const DEFAULT_COUNTRY_CODE = '+61';

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const nanoKey = customAlphabet(KEY_ALPHABET, 32);

/** Device keys use an `rsd_` prefix so they are never confused with form keys (`rsk_`). */
export function generateDeviceKey(): GeneratedKey {
  const key = `rsd_${nanoKey()}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}

export interface SmsConfig {
  serviceAccount: ServiceAccount | null;
  /** Set when a service account is stored but cannot be parsed. */
  serviceAccountError?: string;
  defaultCountryCode: string;
  maxLength: number;
}

export function getSmsConfig(db: DB): SmsConfig {
  const settings = readSettings(db);
  let serviceAccount: ServiceAccount | null = null;
  let serviceAccountError: string | undefined;
  if (settings.fcm_service_account) {
    try {
      serviceAccount = parseServiceAccount(settings.fcm_service_account);
    } catch (err) {
      serviceAccountError = err instanceof Error ? err.message : String(err);
    }
  }
  const defaultCountryCode =
    (settings.sms_default_country_code && normalizeCountryCode(settings.sms_default_country_code)) || DEFAULT_COUNTRY_CODE;
  const maxLength = clampMaxLength(Number(settings.sms_max_length ?? DEFAULT_SMS_MAX_LENGTH));
  return { serviceAccount, serviceAccountError, defaultCountryCode, maxLength };
}

export function getDevice(db: DB, id: string): SmsDeviceRow | undefined {
  return db.prepare('SELECT * FROM sms_devices WHERE id = ?').get(id) as SmsDeviceRow | undefined;
}

export function getDeviceByKeyHash(db: DB, hash: string): SmsDeviceRow | undefined {
  return db.prepare('SELECT * FROM sms_devices WHERE api_key_hash = ?').get(hash) as SmsDeviceRow | undefined;
}

export function listDevices(db: DB): SmsDeviceRow[] {
  return db.prepare('SELECT * FROM sms_devices ORDER BY is_default DESC, created_at ASC').all() as SmsDeviceRow[];
}

function deviceUsable(device: SmsDeviceRow | undefined): device is SmsDeviceRow {
  return Boolean(device && device.enabled === 1 && device.fcm_token);
}

/**
 * Choose the phone to send through: the explicitly requested device when it
 * is usable, otherwise the default device, otherwise the most recently
 * registered usable device.
 */
export function pickDevice(db: DB, deviceId?: string | null): SmsDeviceRow | undefined {
  if (deviceId) {
    const requested = getDevice(db, deviceId);
    if (deviceUsable(requested)) return requested;
  }
  const usable = db
    .prepare(
      `SELECT * FROM sms_devices
       WHERE enabled = 1 AND fcm_token IS NOT NULL AND fcm_token != ''
       ORDER BY is_default DESC, registered_at DESC, created_at DESC`,
    )
    .all() as SmsDeviceRow[];
  return usable[0];
}

/** True when SMS can actually be sent: credentials present and at least one usable phone. */
export function smsReady(db: DB): boolean {
  const config = getSmsConfig(db);
  return Boolean(config.serviceAccount) && pickDevice(db) !== undefined;
}

export function countRegisteredDevices(db: DB): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM sms_devices WHERE enabled = 1 AND fcm_token IS NOT NULL AND fcm_token != ''`)
      .get() as { n: number }
  ).n;
}

/** SQLite-style UTC timestamp ("YYYY-MM-DD HH:MM:SS"), matching datetime('now'). */
export function sqliteTimestamp(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export interface SendSmsArgs {
  to: string;
  message: string;
  formId?: string | null;
  submissionId?: string | null;
  deviceId?: string | null;
}

export interface SendSmsResult {
  id: string;
  status: 'queued' | 'failed';
  error?: string;
  deviceId?: string;
}

/**
 * Queue one outbound SMS: persist it, push the job to the phone over FCM and
 * record the immediate outcome. "queued" means the phone accepted the push;
 * the phone later reports sent/delivered/failed via the sms-status route.
 * Never throws.
 */
export async function sendSms(db: DB, args: SendSmsArgs, opts: FcmOptions = {}): Promise<SendSmsResult> {
  const id = nanoid();
  const now = sqliteTimestamp();
  const insert = db.prepare(
    `INSERT INTO sms_messages
       (id, device_id, direction, recipient, message, status, error_message, form_id, submission_id, requested_at, failed_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const fail = (deviceId: string | null, error: string): SendSmsResult => {
    insert.run(id, deviceId, args.to, args.message, 'failed', error, args.formId ?? null, args.submissionId ?? null, now, now);
    return { id, status: 'failed', error, deviceId: deviceId ?? undefined };
  };

  const config = getSmsConfig(db);
  if (!config.serviceAccount) {
    return fail(null, config.serviceAccountError ?? 'Firebase service account is not configured.');
  }
  const device = pickDevice(db, args.deviceId);
  if (!device) {
    return fail(null, 'No registered phone is available to send SMS.');
  }

  insert.run(id, device.id, args.to, args.message, 'pending', null, args.formId ?? null, args.submissionId ?? null, now, null);

  const smsData = JSON.stringify({
    smsId: id,
    smsBatchId: id,
    message: args.message,
    recipients: [args.to],
    // Legacy field names still read by older app builds.
    smsBody: args.message,
    receivers: [args.to],
  });
  const result = await sendDataMessage(config.serviceAccount, { token: device.fcm_token!, data: { smsData } }, opts);

  if (result.error) {
    db.prepare(`UPDATE sms_messages SET status = 'failed', error_message = ?, failed_at = ? WHERE id = ?`).run(
      result.error,
      sqliteTimestamp(),
      id,
    );
    if (result.unregistered) {
      // The phone's token is dead (app uninstalled / re-registered). Drop it so
      // the UI shows the phone as disconnected instead of failing silently.
      db.prepare(`UPDATE sms_devices SET fcm_token = NULL WHERE id = ?`).run(device.id);
    }
    return { id, status: 'failed', error: result.error, deviceId: device.id };
  }

  db.prepare(`UPDATE sms_messages SET status = 'queued' WHERE id = ?`).run(id);
  return { id, status: 'queued', deviceId: device.id };
}

export function getMessage(db: DB, id: string): SmsMessageRow | undefined {
  return db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id) as SmsMessageRow | undefined;
}

export interface StatusUpdate {
  smsId: string;
  status: string;
  sentAtInMillis?: number;
  deliveredAtInMillis?: number;
  failedAtInMillis?: number;
  errorCode?: string;
  errorMessage?: string;
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 1,
  sent: 2,
  failed: 2,
  delivery_failed: 3,
  delivered: 4,
};

export type StatusUpdateResult = { ok: true; status: string } | { ok: false; code: 400 | 403 | 404; error: string };

/**
 * Apply a status report from the phone. Statuses arrive upper-case
 * (SENT/DELIVERED/FAILED/DELIVERY_FAILED). A lower-ranked status never
 * overwrites a higher one (e.g. a late SENT after DELIVERED), but timestamps
 * and error details are always recorded. The result is mirrored onto the
 * originating submission when there is one.
 */
export function applyStatusUpdate(db: DB, deviceId: string, update: StatusUpdate): StatusUpdateResult {
  const status = update.status.trim().toLowerCase();
  if (!(status in STATUS_RANK) || status === 'pending' || status === 'queued') {
    return { ok: false, code: 400, error: `Unknown status "${update.status}".` };
  }
  const row = getMessage(db, update.smsId);
  if (!row) return { ok: false, code: 404, error: 'SMS not found.' };
  if (row.device_id !== deviceId) return { ok: false, code: 403, error: 'SMS does not belong to this device.' };

  const currentRank = STATUS_RANK[row.status] ?? 0;
  const nextStatus = STATUS_RANK[status] >= currentRank ? status : row.status;
  const sentAt = update.sentAtInMillis ? sqliteTimestamp(update.sentAtInMillis) : row.sent_at;
  const deliveredAt = update.deliveredAtInMillis ? sqliteTimestamp(update.deliveredAtInMillis) : row.delivered_at;
  const failedAt =
    status === 'failed' || status === 'delivery_failed'
      ? sqliteTimestamp(update.failedAtInMillis ?? Date.now())
      : row.failed_at;
  const isFailure = status === 'failed' || status === 'delivery_failed';
  const errorCode = isFailure ? (update.errorCode ?? row.error_code) : row.error_code;
  const errorMessage = isFailure ? (update.errorMessage || update.errorCode || 'Unknown error') : row.error_message;

  db.prepare(
    `UPDATE sms_messages
       SET status = ?, sent_at = ?, delivered_at = ?, failed_at = ?, error_code = ?, error_message = ?
     WHERE id = ?`,
  ).run(nextStatus, sentAt, deliveredAt, failedAt, errorCode, errorMessage, row.id);

  if (row.submission_id) {
    db.prepare(`UPDATE submissions SET sms_status = ?, sms_error = ? WHERE id = ?`).run(
      nextStatus,
      isFailure ? errorMessage : null,
      row.submission_id,
    );
  }
  touchDevice(db, deviceId);
  return { ok: true, status: nextStatus };
}

export interface InboundSms {
  sender: string;
  message: string;
  receivedAtMs: number;
}

/** Store an SMS the phone received (a reply, typically). */
export function recordInboundSms(db: DB, deviceId: string, sms: InboundSms): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO sms_messages (id, device_id, direction, sender, message, status, received_at)
     VALUES (?, ?, 'inbound', ?, ?, 'received', ?)`,
  ).run(id, deviceId, sms.sender, sms.message, sqliteTimestamp(sms.receivedAtMs));
  touchDevice(db, deviceId);
  return id;
}

export function touchDevice(db: DB, deviceId: string): void {
  db.prepare(`UPDATE sms_devices SET last_seen_at = ? WHERE id = ?`).run(sqliteTimestamp(), deviceId);
}

export interface DeviceInfo {
  fcmToken?: string;
  enabled?: boolean;
  brand?: string;
  manufacturer?: string;
  model?: string;
  buildId?: string;
  os?: string;
  osVersion?: string;
  appVersionName?: string;
  appVersionCode?: number;
}

/** Apply a register/update call from the phone. Only supplied fields change. */
export function updateDeviceFromApp(db: DB, deviceId: string, info: DeviceInfo): SmsDeviceRow {
  const current = getDevice(db, deviceId);
  if (!current) throw new Error('Device not found');
  const now = sqliteTimestamp();
  const fcmToken = info.fcmToken && info.fcmToken.length > 0 ? info.fcmToken : current.fcm_token;
  db.prepare(
    `UPDATE sms_devices SET
       fcm_token = ?, enabled = ?, brand = ?, manufacturer = ?, model = ?, build_id = ?, os = ?, os_version = ?,
       app_version_name = ?, app_version_code = ?, registered_at = COALESCE(registered_at, ?), last_seen_at = ?
     WHERE id = ?`,
  ).run(
    fcmToken,
    info.enabled === false ? 0 : 1,
    info.brand ?? current.brand,
    info.manufacturer ?? current.manufacturer,
    info.model ?? current.model,
    info.buildId ?? current.build_id,
    info.os ?? current.os,
    info.osVersion ?? current.os_version,
    info.appVersionName ?? current.app_version_name,
    info.appVersionCode ?? current.app_version_code,
    now,
    now,
    deviceId,
  );
  return getDevice(db, deviceId)!;
}

/** Shape the Android app expects in `data` for device responses (Mongo-style `_id`). */
export function deviceForApp(device: SmsDeviceRow): Record<string, unknown> {
  return {
    _id: device.id,
    name: device.name,
    enabled: device.enabled === 1,
    brand: device.brand,
    manufacturer: device.manufacturer,
    model: device.model,
    buildId: device.build_id,
    os: device.os,
    osVersion: device.os_version,
    appVersionName: device.app_version_name,
    appVersionCode: device.app_version_code,
    createdAt: device.created_at,
    updatedAt: device.last_seen_at,
  };
}
