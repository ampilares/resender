# resender — Project Specification

Self-hosted, open-source email relay for website contact forms. Point any contact form
(e.g. on allenpilares.com) at a resender endpoint and it delivers the submission to your
inbox via your own Gmail account (SMTP app password). Includes an admin web UI to
configure everything. Designed to run on a single VPS via Docker.

Inspired by Resend's API ergonomics and the `references/maildrop` library (nodemailer +
Gmail SMTP auto-config). Maildrop's provider-detection approach may be reused for the
mailer module, but resender is a full service, not a library.

## Goals

- One small Node.js service: public form-relay API + admin API + admin web UI, one port.
- Zero external dependencies at runtime: SQLite on disk, no Redis/Postgres.
- Simple auth: single admin password ("dev login") — this is a personal/small-team tool.
- Safe by default: per-form API keys, origin allowlist, honeypot, rate limiting,
  recipients locked to configured destinations (never an open relay).
- Easy integration: plain HTML `<form action=...>` works with no JavaScript; JSON fetch
  works for SPAs.

## Stack

- Node.js >= 20, TypeScript, ESM.
- Fastify 4 (server), `@fastify/cookie`, `@fastify/static`, `@fastify/cors`.
- `better-sqlite3` (synchronous SQLite; DB file at `$DATA_DIR/resender.db`).
- `nodemailer` for SMTP (Gmail via app password; allow custom SMTP host override).
- `zod` for input validation, `nanoid` for IDs/keys.
- Admin UI: Vite + React 18 + TypeScript + Tailwind CSS, built to static files and
  served by Fastify at `/` (SPA fallback). React Router for pages.
- No ORM. Plain SQL with a tiny migration runner (numbered migrations applied at boot).

## Repository layout

```
resender/
├── package.json            # root: server package, workspaces NOT required
├── tsconfig.json
├── src/                    # Fastify server (TypeScript)
│   ├── index.ts            # entrypoint: build server, listen
│   ├── config.ts           # env parsing (PORT, DATA_DIR, ADMIN_PASSWORD, SESSION_SECRET, BASE_URL)
│   ├── db.ts               # better-sqlite3 init + migrations
│   ├── mailer.ts           # nodemailer transport from settings (gmail auto-config like maildrop)
│   ├── auth.ts             # admin session handling (signed cookie)
│   ├── rateLimit.ts        # in-memory sliding-window limiter (per IP+form)
│   ├── emailTemplate.ts    # HTML email rendering of a form submission
│   └── routes/
│       ├── public.ts       # POST /api/v1/forms/:slug, POST /api/v1/send, GET /api/health
│       └── admin.ts        # /api/admin/* (login, forms CRUD, settings, submissions, stats)
├── web/                    # Vite React admin UI (own package.json)
│   └── src/...
├── data/                   # runtime data dir (gitignored)
├── Dockerfile              # multi-stage: build web + server, slim runtime
├── docker-compose.yml
├── .env.example
├── LICENSE                 # MIT
└── README.md
```

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite + generated secret live here |
| `ADMIN_PASSWORD` | `admin` | If left as `admin`, UI shows a red "change this" banner |
| `SESSION_SECRET` | auto | If unset, generated once and persisted to `$DATA_DIR/secret` |
| `BASE_URL` | `http://localhost:3000` | Used to render endpoint URLs/snippets in the UI |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/Caddy so client IPs are correct |

SMTP credentials are NOT env vars — they are configured in the admin UI and stored in
the `settings` table (single-user tool on a private VPS; document this trade-off).

## Database schema

```sql
-- settings: single-row key/value
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: smtp_email, smtp_password, smtp_host?, smtp_port?, smtp_secure?, from_email?, from_name

CREATE TABLE forms (
  id TEXT PRIMARY KEY,              -- nanoid(12)
  name TEXT NOT NULL,               -- "allenpilares.com contact"
  slug TEXT NOT NULL UNIQUE,        -- url-safe, e.g. "allenpilares-contact"
  destination_email TEXT NOT NULL,  -- legacy/primary destination
  destination_emails TEXT NOT NULL DEFAULT '[]', -- JSON recipient list
  subject_template TEXT NOT NULL DEFAULT 'New submission from {{form}}',
  allowed_origins TEXT NOT NULL DEFAULT '[]',  -- JSON array; empty = allow all (warn in UI)
  redirect_url TEXT,                -- 302 target for non-JS HTML form posts
  api_key_hash TEXT NOT NULL,       -- sha256 of full key
  api_key_prefix TEXT NOT NULL,     -- first 8 chars, shown in UI
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,            -- JSON of submitted fields
  reply_to TEXT,                    -- submitter's email field if present
  status TEXT NOT NULL,             -- 'sent' | 'failed' | 'spam' | 'rate_limited'
  error TEXT,
  message_id TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_submissions_form_created ON submissions(form_id, created_at DESC);
```

API keys: generated as `rsk_` + nanoid(32), shown ONCE at creation/regeneration, stored
only as sha256 hash + prefix.

## Public API

### `POST /api/v1/forms/:slug` — form relay (primary endpoint)

- Accepts `application/x-www-form-urlencoded`, `multipart/form-data` (fields only, no
  file uploads in v1), or `application/json`.
- No API key required (it's meant for browser forms) — protection is origin allowlist +
  honeypot + rate limit.
- Reserved fields: `_gotcha` (honeypot — if non-empty, record status `spam`, return
  success to fool bots), `_subject` (overrides subject), `_replyto`/`email` (used as
  Reply-To after validation).
- Checks, in order: form exists & enabled → honeypot → origin (if allowlist non-empty,
  `Origin`/`Referer` host must match; mismatch = 403) → rate limit (default 5 requests
  per minute per IP per form; over = 429, record `rate_limited`) → payload non-empty,
  max 50 fields, each value max 10 KB.
- Sends email: to every address in `destination_emails`, from `"<from_name>" <from_email>`, falling back to `smtp_email`, Reply-To
  submitter, subject from template (`{{form}}`, `{{subject}}` placeholders), HTML body =
  clean table of submitted fields (via `emailTemplate.ts`) + plain-text alternative.
- Response: JSON request → `200 {"ok":true,"id":"..."}`. Form-encoded request → 302 to
  `redirect_url` if set, else a minimal built-in "Thanks" HTML page.
- Errors: `404` unknown slug, `403` origin, `429` rate, `400` validation,
  `502 {"ok":false,"error":"..."}` when SMTP fails (also logged as `failed`).
- CORS: reflect allowed origins (or `*` when allowlist empty) for this route only.

### `POST /api/v1/send` — programmatic send (Resend-style)

- Auth: `Authorization: Bearer rsk_...` (matched by hash against a form; the form's
  destination is the implicit recipient).
- Body (JSON): `{ subject, html?, text?, replyTo? }` — at least one of html/text.
  **No `to` field**: recipient is always the form's configured destination emails (prevents use
  as an open relay).
- Same send/log pipeline. Response `200 {"ok":true,"id":...}` / `401` / `502`.

### `GET /api/health` → `{"ok":true}`

## Admin API (session cookie auth)

- `POST /api/admin/login` `{password}` → sets signed HTTP-only cookie (7-day expiry).
  Constant-time compare. 1s delay on failure.
- `POST /api/admin/logout`
- `GET /api/admin/me` → `{authenticated, defaultPassword: bool, smtpConfigured: bool}`
- `GET/POST /api/admin/settings` — SMTP email/password (password write-only: GET returns
  `smtp_password_set: true/false`, never the value), optional host/port/secure override,
  from_email and from_name. The From address falls back to smtp_email when unset. Auto-detect host
  from the SMTP login email domain like maildrop when no override.
- `POST /api/admin/settings/test` `{to?}` — sends a test email (default: to smtp_email),
  returns success or the SMTP error message verbatim.
- `GET/POST /api/admin/forms`, `GET/PATCH/DELETE /api/admin/forms/:id`,
  `POST /api/admin/forms/:id/regenerate-key` (returns the new full key once).
  Create returns the full API key once.
- `GET /api/admin/submissions?form_id=&status=&page=` — paginated, newest first.
- `GET /api/admin/stats` — totals: sent/failed/spam last 24h & 30d, per-form counts.

All `/api/admin/*` except login return `401` without a valid session.

## Admin UI (React SPA)

Pages (React Router):
1. **Login** — password field. Red banner hint if `defaultPassword` is true after login.
2. **Dashboard** — stat cards (sent 24h/30d, failed, spam), recent submissions table,
   setup checklist when SMTP unconfigured or no forms exist ("1. Connect Gmail →
   2. Create a form → 3. Copy the snippet").
3. **Forms** — list; create/edit drawer or page (name, slug auto-suggested from name,
   destination email, subject template, allowed origins as tag input, redirect URL,
   enabled toggle). Detail view shows the endpoint URL and ready-to-copy integration
   snippets (plain HTML form / fetch JS) with copy buttons, API key prefix, and
   regenerate-key button (shows full key once in a modal).
4. **Settings** — Gmail address + app password fields, collapsible "use custom SMTP"
   (host/port/secure), from name, "Send test email" button with inline result. Include a
   short help block: link to https://myaccount.google.com/apppasswords and the
   2FA-required note.
5. **Logs** — submissions table with status filter and form filter, expandable row to
   view payload JSON and error text.

Style: clean, minimal, dark-mode-friendly (Tailwind, system font stack, single accent
color). No component library required; keep it small and tasteful. App name "resender"
in a simple wordmark.

SPA calls the admin API with `credentials: 'include'`; on 401 redirect to /login.
In dev, Vite proxies `/api` to `localhost:3000`.

## Build & run

- `npm run dev` — tsx watch server (port 3000) + instructions to run `npm run dev` in
  `web/` (port 5173, proxied) — document both; a root `dev` script may use `concurrently`.
- `npm run build` — builds `web/` (output to `web/dist`), then `tsc` server to `dist/`.
  Server serves `web/dist` statically with SPA fallback for non-`/api` routes.
- `npm start` — `node dist/index.js`.
- Dockerfile: multi-stage (deps → build web → build server → `node:20-slim` runtime,
  non-root user, `VOLUME /data`, `ENV DATA_DIR=/data`, `EXPOSE 3000`,
  HEALTHCHECK hitting /api/health).
- docker-compose.yml: single service, volume `./data:/data`, env vars documented inline.

## README requirements

Badges-light, practical README: what it is (one paragraph + feature bullets), quickstart
with docker compose, Gmail app-password setup steps, screenshots placeholder section,
integration examples (plain HTML form, fetch JS, React example, curl for /api/v1/send),
reverse-proxy note (Caddy/nginx snippet, TRUST_PROXY), Gmail daily-limit note
(~500/day), security model explanation, development setup, MIT license.

## Non-goals (v1)

- Multi-user accounts / OAuth login
- File attachments from forms
- Email open/click tracking, templates builder, campaigns
- Queue/retry system (a failed send is logged and visible in UI; that's enough)
