import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, CopyButton, Modal, PageLoader } from '../components/ui';
import FormEditor from '../components/FormEditor';
import { ApiKeyReveal } from './Forms';
import type { Form, FormInput } from '../types';

export default function FormDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [regenerated, setRegenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.get<{ form: Form }>(`/api/admin/forms/${id}`);
      setForm(res.form);
    } catch {
      setNotFound(true);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Endpoint URL is derived from where the SPA is served, not a server BASE_URL.
  const endpoint = useMemo(() => {
    if (!form) return '';
    return `${window.location.origin}/api/v1/forms/${form.slug}`;
  }, [form]);

  const save = async (input: FormInput) => {
    const res = await api.patch<{ form: Form }>(`/api/admin/forms/${id}`, input);
    setForm(res.form);
    setEditing(false);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/api/admin/forms/${id}`);
      navigate('/forms', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ api_key: string; api_key_prefix: string }>(
        `/api/admin/forms/${id}/regenerate-key`,
      );
      setConfirmRegen(false);
      setRegenerated(res.api_key);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <Card className="p-10 text-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">Form not found.</p>
        <Link to="/forms" className="mt-3 inline-block text-sm font-medium text-indigo-600 dark:text-indigo-400">
          ← Back to forms
        </Link>
      </Card>
    );
  }

  if (!form) return <PageLoader />;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/forms" className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
          ← Forms
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">{form.name}</h1>
            <p className="mt-0.5 font-mono text-sm text-gray-500 dark:text-gray-400">{form.slug}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        </div>
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Endpoint</h2>
        <div className="mt-2 flex items-center gap-2 rounded-md bg-gray-50 p-3 ring-1 ring-inset ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
          <code className="flex-1 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{endpoint}</code>
          <CopyButton text={endpoint} />
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Detail label="Destinations" value={form.destination_emails.join(', ')} />
          <Detail label="Subject template" value={form.subject_template} mono />
          <Detail
            label="Allowed origins"
            value={form.allowed_origins.length ? form.allowed_origins.join(', ') : 'Any (no allowlist)'}
          />
          <Detail label="Redirect URL" value={form.redirect_url ?? '—'} />
          <Detail label="Turnstile" value={form.turnstile_enabled ? 'Required' : 'Off'} />
          <Detail label="Spam threshold" value={`${form.spam_score_threshold} points`} />
          <Detail label="Status" value={form.enabled ? 'Enabled' : 'Disabled'} />
        </dl>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">API key</h2>
          <Button variant="secondary" onClick={() => setConfirmRegen(true)}>
            Regenerate key
          </Button>
        </div>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Key prefix:{' '}
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-900 dark:bg-gray-800 dark:text-gray-100">
            {form.api_key_prefix}…
          </code>
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The full key is only shown once. Regenerate if it is lost or compromised. Used for{' '}
          <code className="font-mono">POST /api/v1/send</code> (the public form endpoint needs no key).
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Integration snippets</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Point your contact form at the endpoint above. Spam scoring is automatic; use the Turnstile markup exactly as shown when enabled.
        </p>
        <div className="mt-4 space-y-5">
          <Snippet title="Plain HTML form" code={htmlSnippet(endpoint, form)} />
          <Snippet title="JavaScript (fetch)" code={fetchSnippet(endpoint, form)} />
        </div>
      </Card>

      {/* Edit */}
      <Modal open={editing} onClose={() => setEditing(false)} title="Edit form">
        <FormEditor initial={form} submitLabel="Save changes" onSubmit={save} onCancel={() => setEditing(false)} />
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete form?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={remove}>
              Delete form
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-400">
          This permanently deletes <strong className="text-gray-900 dark:text-gray-100">{form.name}</strong> and all of
          its submission history. This cannot be undone.
        </p>
      </Modal>

      {/* Regenerate confirm */}
      <Modal
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        title="Regenerate API key?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRegen(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={regenerate}>
              Regenerate
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-400">
          The current key stops working immediately. Any integration using{' '}
          <code className="font-mono">/api/v1/send</code> must be updated with the new key.
        </p>
      </Modal>

      {/* Reveal new key once */}
      <Modal
        open={regenerated !== null}
        onClose={() => setRegenerated(null)}
        title="New API key"
        footer={<Button onClick={() => setRegenerated(null)}>Done</Button>}
      >
        {regenerated && <ApiKeyReveal apiKey={regenerated} />}
      </Modal>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`mt-0.5 break-words text-gray-800 dark:text-gray-200 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</h3>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto rounded-md bg-gray-900 p-4 text-xs leading-relaxed text-gray-100 dark:bg-black/40">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function htmlSnippet(endpoint: string, form: Form): string {
  const turnstile =
    form.turnstile_enabled && form.turnstile_site_key
      ? `  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <div class="cf-turnstile" data-sitekey="${form.turnstile_site_key}" data-action="resender_form"></div>
  <input type="hidden" name="_form_started_at" id="resender-form-started-at" />
  <script>document.getElementById("resender-form-started-at").value = String(Date.now());</script>
`
      : '';
  return `<form action="${endpoint}" method="POST">
  <input type="text" name="name" placeholder="Your name" required />
  <input type="email" name="email" placeholder="Your email" required />
  <textarea name="message" placeholder="Message" required></textarea>
  <!-- Honeypot: leave empty. Bots that fill it are silently dropped. -->
  <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off" />
${turnstile}  <button type="submit">Send</button>
</form>`;
}

function fetchSnippet(endpoint: string, form: Form): string {
  const turnstileSetup =
    form.turnstile_enabled && form.turnstile_site_key
      ? `// In your form markup:
// <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
// <div class="cf-turnstile" data-sitekey="${form.turnstile_site_key}" data-action="resender_form"></div>
const formStartedAt = Date.now();

`
      : '';
  const turnstileFields = form.turnstile_enabled
    ? `
    "cf-turnstile-response": turnstile.getResponse(),
    _form_started_at: String(formStartedAt),`
    : '';
  return `${turnstileSetup}const res = await fetch("${endpoint}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Ada Lovelace",
    email: "ada@example.com",
    message: "Hello!",${turnstileFields}
  }),
});
const data = await res.json();
if (data.ok) {
  // submission accepted
} else if (window.turnstile) {
  turnstile.reset();
}`;
}
