import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { loadConfig, type Config } from './config.js';
import { openDb, type DB } from './db.js';
import { RateLimiter } from './rateLimit.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { gatewayRoutes } from './routes/gateway.js';

export interface AppContext {
  db: DB;
  config: Config;
  limiter: RateLimiter;
}

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const db = openDb(config.dbPath);
  const limiter = new RateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
  const ctx: AppContext = { db, config, limiter };

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024, // 1 MB
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(formbody);
  await app.register(multipart, {
    limits: { fileSize: 0, files: 0, fieldSize: 100 * 1024 },
  });

  await app.register(publicRoutes, { ctx });
  await app.register(gatewayRoutes, { ctx });
  await app.register(adminRoutes, { ctx });

  await registerStatic(app);

  app.addHook('onClose', async () => {
    db.close();
  });

  return app;
}

/**
 * Serve the built admin UI from web/dist with SPA fallback for non-/api GET
 * routes. If web/dist is absent (UI not built yet), serve a plain-text note.
 */
async function registerStatic(app: FastifyInstance): Promise<void> {
  const webDist = join(process.cwd(), 'web', 'dist');

  if (!existsSync(join(webDist, 'index.html'))) {
    app.get('/', async (_req, reply) => {
      reply
        .type('text/plain')
        .send('resender is running. The admin UI has not been built yet (web/dist missing). Run the web build, or use the API at /api.');
    });
    return;
  }

  await app.register(fastifyStatic, { root: webDist });

  app.setNotFoundHandler((request, reply) => {
    // SPA fallback for page routes only — a missing asset must 404, not
    // come back as index.html masquerading as JS/CSS.
    if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/assets/')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ ok: false, error: 'Not found' });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`resender listening on ${config.baseUrl}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Run only when executed directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js');
if (isMain) {
  void main();
}
