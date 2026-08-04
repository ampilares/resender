# resender

Self-hosted, open-source email relay for website contact forms. Point any contact form at a
resender endpoint and it delivers the submission to your inbox through your own Gmail account
(or any SMTP provider) using an app password. Ships with an admin web UI to manage forms,
credentials, and logs. Runs as a single Node.js service on one port, backed by SQLite — no
Redis, no Postgres, no external services.

Inspired by [Resend](https://resend.com)'s API ergonomics. The SMTP layer (nodemailer + Gmail
provider auto-detection) was inspired by the `references/maildrop` library included in this repo.

## Features

- **Plain HTML forms work with zero JavaScript** — `<form action="…">` posts and redirects to a
  thank-you page or your own URL.
- **JSON API for SPAs** — post `application/json` and get `{ "ok": true, "id": "…" }` back.
- **Programmatic send** — a Resend-style `POST /api/v1/send` with a Bearer API key.
- **Layered spam protection** — Cloudflare Turnstile, weighted spam scoring, duplicate/burst
  detection, origin allowlists, honeypots, and rate limiting with explainable decisions in logs.
- **Admin UI** — connect Gmail, create forms, copy ready-made snippets, and browse submission logs.
- **Single container** — one port, one SQLite file on a mounted volume.

## Quickstart (Docker Compose)

```bash
git clone https://github.com/allenpilares/resender.git
cd resender

# optional: seed environment overrides
cp .env.example .env

docker compose up -d --build
```

Then open <http://localhost:3000> and log in with the admin password (default `admin` — change it,
see below). The database and session secret are persisted to `./data`.

Set at least these in `docker-compose.yml` (or `.env`) before exposing publicly:

- `ADMIN_PASSWORD` — anything other than the default `admin`.
- `BASE_URL` — the public URL, e.g. `https://forms.example.com`. It's only used to render the
  endpoint URLs and copy-paste snippets in the UI.
- `TRUST_PROXY=true` — if you run behind nginx/Caddy (see [Reverse proxy](#reverse-proxy)).

### Configuration

All configuration is via environment variables (see `.env.example`):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite DB (`resender.db`) and generated secret. |
| `ADMIN_PASSWORD` | `admin` | If left as `admin`, the UI flags it after login. |
| `SESSION_SECRET` | auto | If unset, generated once and persisted to `$DATA_DIR/secret`. |
| `BASE_URL` | `http://localhost:3000` | Used to render endpoint URLs/snippets in the UI. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so client IPs are correct. |
| `TURNSTILE_SITE_KEY` | unset | Public widget key; set together with the secret key. |
| `TURNSTILE_SECRET_KEY` | unset | Server-only Siteverify secret; never expose it in site code. |

### Turnstile and spam scoring

1. Create a [Cloudflare Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/)
   and allow every hostname where the contact form is embedded.
2. Set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, then restart resender.
3. Enable **Require Cloudflare Turnstile** on existing forms and replace their integrations with
   the newly generated snippet. New forms default to Turnstile-on when the keys are configured.

Resender validates every token server-side, checks the fixed `resender_form` action and request
hostname, and fails closed when verification is invalid or unavailable. After a valid challenge,
a weighted score still checks URL density, shorteners, active HTML, solicitation language,
disposable email providers, invisible text, submission speed, exact duplicates, and sender/IP
bursts. The default blocking threshold is 5 points; each form can set 1 (strict) through 20
(permissive). Scores and reasons are visible in **Logs**.

**SMTP credentials are not environment variables.** They are entered in the admin UI (Settings)
and stored in the SQLite `settings` table. This is a deliberate trade-off for a single-user tool
on a private VPS: it keeps setup UI-driven and avoids leaking a password into shell history or
process listings, at the cost of storing the app password in the database file. Keep `DATA_DIR`
private.

## Connect Gmail (app password)

Gmail rejects your normal account password over SMTP. You need a 16-character **app password**,
which requires 2-Step Verification:

1. Enable **2-Step Verification** on your Google account: <https://myaccount.google.com/security>.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Create a new app password (name it e.g. "resender"). Google shows a 16-character string.
4. In the resender admin UI → **Settings**, enter your Gmail address and paste the app password
   (spaces don't matter), set the From name/address, then click **Send test email** to verify.

To send from a Google Workspace alias, use the primary Google account as **SMTP login email** and
its app password, then enter the alias as **From email**. For example, an SMTP login of
`amp@rethink-tech.com` can send as `mail@pixelmate.com.au` when that alias is configured and
permitted in Google Workspace. Because Workspace domains cannot be auto-detected as Gmail, also
enable **Use custom SMTP server** and set `smtp.gmail.com`, port `587`, with the secure/port-465
option off (STARTTLS is negotiated automatically).

resender auto-detects the SMTP host from the email domain (Gmail, Outlook/Hotmail/Live, Yahoo,
Zoho, iCloud). For anything else, expand **Use custom SMTP** and set host/port/secure explicitly.

> **Gmail sending limit:** a regular Gmail account can send roughly **500 emails per day**. That is
> plenty for typical contact-form traffic, but if you expect more, use Google Workspace (higher
> limits) or a dedicated provider via custom SMTP.

## Screenshots

_Add screenshots of the admin UI here._

- `docs/dashboard.png` — dashboard with stat cards and recent submissions
- `docs/forms.png` — form detail with copy-ready snippets
- `docs/settings.png` — Gmail / SMTP settings with the test-email button

## Integration examples

Create a form in the admin UI first. It gets a **slug** (e.g. `allenpilares-contact`); the public
endpoint is `POST {BASE_URL}/api/v1/forms/{slug}`. No API key is needed for this endpoint —
protection can include Turnstile, origin checks, a honeypot, rate limits, and weighted spam scoring.

Reserved field names:

- `_gotcha` — honeypot. Keep it hidden from real users; if a bot fills it, the submission is
  recorded as spam and a fake success is returned. Not included in the delivered email.
- `_subject` — overrides the subject where the form's template contains `{{subject}}`.
- `_replyto` — the reply-to address. If absent, a valid field named `email` is used instead.
- `cf-turnstile-response` — the single-use widget token, generated automatically by Turnstile.
- `_form_started_at` — optional browser timestamp used as one low-weight scoring signal.

All reserved fields are stripped from delivered emails, and CAPTCHA tokens are never stored.

### Plain HTML form (no JavaScript)

```html
<form action="https://forms.example.com/api/v1/forms/allenpilares-contact" method="POST">
  <input type="text"  name="name"    placeholder="Your name" required>
  <input type="email" name="email"   placeholder="you@example.com" required>
  <textarea name="message" placeholder="Message" required></textarea>

  <!-- Honeypot: hide this from humans; bots tend to fill it. -->
  <input type="text" name="_gotcha" tabindex="-1" autocomplete="off"
         style="position:absolute;left:-9999px" aria-hidden="true">

  <button type="submit">Send</button>
</form>
```

On success a form-encoded post redirects to the form's **Redirect URL** if set, otherwise it shows
a minimal built-in "Thanks" page.

### fetch (JSON)

```js
const res = await fetch("https://forms.example.com/api/v1/forms/allenpilares-contact", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Ada Lovelace",
    email: "ada@example.com",     // used as Reply-To
    message: "Hello!",
    _subject: "New portfolio inquiry",
  }),
});
const data = await res.json(); // { ok: true, id: "..." }
```

### React

```jsx
function ContactForm() {
  const [status, setStatus] = React.useState("idle");

  async function onSubmit(e) {
    e.preventDefault();
    setStatus("sending");
    const form = new FormData(e.currentTarget);
    const res = await fetch(
      "https://forms.example.com/api/v1/forms/allenpilares-contact",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      },
    );
    setStatus(res.ok ? "sent" : "error");
  }

  return (
    <form onSubmit={onSubmit}>
      <input name="name" required />
      <input name="email" type="email" required />
      <textarea name="message" required />
      <input type="text" name="_gotcha" hidden aria-hidden="true" />
      <button disabled={status === "sending"}>Send</button>
      {status === "sent" && <p>Thanks!</p>}
      {status === "error" && <p>Something went wrong.</p>}
    </form>
  );
}
```

### Programmatic send (`/api/v1/send`, Bearer key)

For transactional emails from your backend. Each form has an API key (`rsk_…`, shown once when the
form is created or its key is regenerated). The recipients are **always** the form's configured
destinations — there is no `to` field, so the key can never be used as an open relay.

```bash
curl https://forms.example.com/api/v1/send \
  -H "Authorization: Bearer rsk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{
        "subject": "Order #1234 shipped",
        "html": "<p>Your order is on the way.</p>",
        "replyTo": "support@example.com"
      }'
```

Body: `subject` (required) plus at least one of `html` or `text`; `replyTo` optional. Responses:
`200 { "ok": true, "id": "…" }`, `401` (missing/invalid key), `400` (bad body), `502` (SMTP failed).

### Health check

`GET /api/health` → `{ "ok": true }`.

## Reverse proxy

Run resender behind a TLS-terminating proxy and set `TRUST_PROXY=true` so client IPs (used for rate
limiting and logs) come from `X-Forwarded-For` rather than the proxy's address.

**Caddy** (`Caddyfile`):

```
forms.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name forms.example.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

With either proxy in front, set `TRUST_PROXY=true` in resender's environment.

## Security model

- **Not an open relay.** Both endpoints deliver only to a form's pre-configured
  `destination_email`. `/api/v1/send` has no `to` field at all.
- **Origin allowlist.** Per form, list the domains allowed to post. When the list is non-empty, the
  request's `Origin`/`Referer` host must match or it's rejected with `403`. An empty list allows any
  origin (fine for public contact forms; the UI warns about it).
- **Turnstile.** Enabled forms require server-side Siteverify validation. The action and originating
  hostname are checked, and token/API failures fail closed.
- **Weighted spam scoring.** Explainable content, identity, timing, duplicate, and burst signals are
  combined per form. Scores at or above the configured threshold are logged as `spam` and not sent.
- **Honeypot.** The reserved `_gotcha` field traps bots: a non-empty value records the submission as
  `spam` and returns a fake success, without sending mail.
- **Rate limiting.** In-memory sliding window, default **5 requests per minute per IP per form**.
  Over the limit returns `429` and logs a `rate_limited` submission. (In-memory means limits reset
  on restart and are per-process.)
- **API keys hashed.** Keys are `rsk_` + 32 random chars, shown once, and stored only as a SHA-256
  hash plus an 8-character prefix for display. Lost keys are regenerated, not recovered.
- **Payload limits.** Max 50 fields per submission, each string value up to 10 KB, 1 MB total body.
  File uploads are accepted by multipart parsing but discarded (fields only in v1). CAPTCHA
  tokens and other reserved control fields are stripped before logging or delivery.
- **Admin session.** Single admin password (constant-time compare, 1s delay on failure). The session
  is an HMAC-signed, HTTP-only cookie (7-day expiry); no session table.

## Local development

Requires Node.js >= 20.

```bash
# 1. Install server deps (repo root) and web UI deps
npm install
cd web && npm install && cd ..

# 2. Run the server (tsx watch, port 3000)
npm run dev

# 3. In a second terminal, run the Vite dev server (port 5173)
cd web && npm run dev
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to the server on port 3000, so the
session cookie works across both. To produce a production build:

```bash
npm run build   # builds web/ -> web/dist, then compiles the server -> dist/
npm start       # node dist/index.js, serves web/dist with SPA fallback
```

## Project structure

```
resender/
├── src/                    # Fastify server (TypeScript, ESM)
│   ├── index.ts            # entrypoint: build server, serve web/dist, listen
│   ├── config.ts           # env parsing (PORT, DATA_DIR, ADMIN_PASSWORD, …)
│   ├── db.ts               # better-sqlite3 init + migrations
│   ├── mailer.ts           # nodemailer transport + Gmail-style host auto-detect
│   ├── auth.ts             # admin session (signed cookie) + API-key hashing
│   ├── rateLimit.ts        # in-memory sliding-window limiter (per IP+form)
│   ├── emailTemplate.ts    # HTML/text rendering of a submission
│   └── routes/
│       ├── public.ts       # POST /api/v1/forms/:slug, POST /api/v1/send, GET /api/health
│       └── admin.ts        # /api/admin/* (login, forms, settings, submissions, stats)
├── web/                    # Vite + React + Tailwind admin UI (own package.json)
├── data/                   # runtime SQLite DB + secret (gitignored)
├── references/maildrop/    # SMTP provider-detection reference that inspired mailer.ts
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## License

MIT © 2026 Allen Pilares. See [LICENSE](./LICENSE).
