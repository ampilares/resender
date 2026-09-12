import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../index.js';
import type { SmsDeviceRow } from '../db.js';
import { hashApiKey } from '../auth.js';
import {
  applyStatusUpdate,
  deviceForApp,
  getDeviceByKeyHash,
  recordInboundSms,
  updateDeviceFromApp,
} from '../sms/gateway.js';

/**
 * Android-facing gateway API. This is the subset of the selfhostsim /
 * textbee API the SMS gateway app actually calls, so the unmodified app can
 * be pointed at resender by setting its API base URL to
 * `https://<resender>/api/v1/`. Every route authenticates with the device
 * key in the `x-api-key` header.
 */

interface PluginOpts {
  ctx: AppContext;
}

declare module 'fastify' {
  interface FastifyRequest {
    smsDevice?: SmsDeviceRow;
  }
}

const REGISTER_PATH = '/api/v1/gateway/devices';

// Gson serialises unset Java longs as 0, so treat 0 as "not provided".
const millis = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value) => {
    const n = typeof value === 'string' ? Number(value) : value;
    return n && Number.isFinite(n) && n > 0 ? n : undefined;
  });

const optionalString = z.string().max(500).optional();

const deviceInputSchema = z.object({
  fcmToken: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
  brand: optionalString,
  manufacturer: optionalString,
  model: optionalString,
  buildId: optionalString,
  os: optionalString,
  osVersion: optionalString,
  appVersionName: optionalString,
  appVersionCode: z.union([z.number(), z.string()]).optional().transform((v) => (v === undefined ? undefined : Number(v))),
});

const statusSchema = z.object({
  smsId: z.string().min(1),
  smsBatchId: z.string().optional(),
  status: z.string().min(1).max(40),
  sentAtInMillis: millis,
  deliveredAtInMillis: millis,
  failedAtInMillis: millis,
  errorCode: z.string().max(200).optional(),
  errorMessage: z.string().max(2000).optional(),
});

const receivedSchema = z.object({
  sender: z.string().min(1).max(100),
  message: z.string().max(10_000),
  receivedAtInMillis: millis,
  receivedAt: z.string().optional(),
});

function fail(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ success: false, error });
}

export const gatewayRoutes: FastifyPluginAsync<PluginOpts> = async (app: FastifyInstance, opts) => {
  const { db, limiter } = opts.ctx;

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];
    // Registration is the only route a key-guessing bot would hammer; the
    // status/receive routes are called legitimately several times per SMS.
    if (request.method === 'POST' && path === REGISTER_PATH && !limiter.check(`gateway-register:${request.ip}`)) {
      return fail(reply, 429, 'Too many requests.');
    }

    const header = request.headers['x-api-key'];
    const query = (request.query as { apiKey?: string } | undefined)?.apiKey;
    const key = (Array.isArray(header) ? header[0] : header) ?? query;
    if (!key || typeof key !== 'string' || !key.startsWith('rsd_')) {
      return fail(reply, 401, 'Missing or invalid API key.');
    }
    const device = getDeviceByKeyHash(db, hashApiKey(key.trim()));
    if (!device) return fail(reply, 401, 'Invalid API key.');

    const id = (request.params as { id?: string }).id;
    if (id !== undefined && id !== device.id) {
      return fail(reply, 403, 'Device id does not match this API key.');
    }
    request.smsDevice = device;
  });

  // The app calls this once with a fresh key; the device row already exists
  // (created in the admin UI), so "register" fills in the phone's details.
  app.post(REGISTER_PATH, async (request, reply) => {
    const parsed = deviceInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid device.');
    const device = updateDeviceFromApp(db, request.smsDevice!.id, parsed.data);
    app.log.info({ device: device.id, model: device.model }, 'sms device registered');
    return reply.code(201).send({ success: true, data: deviceForApp(device) });
  });

  app.patch(`${REGISTER_PATH}/:id`, async (request, reply) => {
    const parsed = deviceInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid device.');
    const device = updateDeviceFromApp(db, request.smsDevice!.id, parsed.data);
    return reply.send({ success: true, data: deviceForApp(device) });
  });

  app.patch(`${REGISTER_PATH}/:id/sms-status`, async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid status update.');
    const result = applyStatusUpdate(db, request.smsDevice!.id, parsed.data);
    if (!result.ok) return fail(reply, result.code, result.error);
    return reply.send({ success: true, data: { smsId: parsed.data.smsId, status: result.status } });
  });

  app.post(`${REGISTER_PATH}/:id/receive-sms`, async (request, reply) => {
    const parsed = receivedSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid received SMS.');
    const { sender, message, receivedAtInMillis, receivedAt } = parsed.data;
    let receivedAtMs = receivedAtInMillis;
    if (!receivedAtMs && receivedAt) {
      const t = Date.parse(receivedAt);
      if (Number.isFinite(t)) receivedAtMs = t;
    }
    const id = recordInboundSms(db, request.smsDevice!.id, {
      sender,
      message,
      receivedAtMs: receivedAtMs ?? Date.now(),
    });
    return reply.send({ success: true, data: { _id: id } });
  });
};
