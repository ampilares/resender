import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Button, Card, ErrorText, Field, inputClass, PageLoader } from '../components/ui';
import type { Settings as SettingsData } from '../types';

export default function Settings() {
  const { refresh } = useAuth();
  const [loaded, setLoaded] = useState<SettingsData | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [secure, setSecure] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      const s = await api.get<SettingsData>('/api/admin/settings');
      setLoaded(s);
      setEmail(s.smtp_email);
      setFromEmail(s.from_email);
      setFromName(s.from_name);
      setHost(s.smtp_host);
      setPort(s.smtp_port ? String(s.smtp_port) : '');
      setSecure(s.smtp_secure);
      if (s.smtp_host) setUseCustom(true);
    })();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    setSaveErr(null);
    try {
      const body: Record<string, unknown> = {
        smtp_email: email.trim(),
        from_email: fromEmail.trim(),
        from_name: fromName.trim(),
      };
      // Password is write-only; only send when the user typed a new value.
      if (password.length > 0) body.smtp_password = password;
      if (useCustom) {
        body.smtp_host = host.trim();
        body.smtp_port = port.trim();
        body.smtp_secure = secure;
      } else {
        // Clear any custom override so the server auto-detects from the domain.
        body.smtp_host = '';
        body.smtp_port = '';
        body.smtp_secure = false;
      }
      await api.post('/api/admin/settings', body);
      setPassword('');
      setSaveMsg('Settings saved.');
      const s = await api.get<SettingsData>('/api/admin/settings');
      setLoaded(s);
      await refresh(); // updates smtpConfigured for setup checklist / banner state
    } catch (err) {
      setSaveErr(err instanceof ApiError ? err.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post<{ ok: boolean; messageId?: string }>('/api/admin/settings/test', {});
      setTestResult({ ok: true, message: `Test email sent${res.messageId ? ` (${res.messageId})` : ''}.` });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof ApiError ? err.message : 'Test failed.' });
    } finally {
      setTesting(false);
    }
  };

  if (!loaded) return <PageLoader />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">Settings</h1>

      <form onSubmit={save} className="space-y-6">
        <Card className="space-y-5 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Gmail / SMTP</h2>

          <Field label="SMTP login email" htmlFor="email" hint="The Google account that owns the app password.">
            <input
              id="email"
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>

          <Field
            label="App password"
            htmlFor="password"
            hint={
              loaded.smtp_password_set
                ? 'A password is already saved. Leave blank to keep it, or enter a new one to replace it.'
                : 'A Gmail app password (not your normal password).'
            }
          >
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={loaded.smtp_password_set ? '••••••••••••' : 'abcd efgh ijkl mnop'}
            />
          </Field>

          <Field
            label="From email"
            htmlFor="fromEmail"
            hint="The address recipients see. It must be an alias that your SMTP account is allowed to send as. Leave blank to use the login email."
          >
            <input
              id="fromEmail"
              type="email"
              className={inputClass}
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder={email || 'mail@example.com'}
            />
          </Field>
          <Field label="From name" htmlFor="fromName" hint="Display name on delivered emails, e.g. “Website contact form”.">
            <input
              id="fromName"
              className={inputClass}
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Website contact form"
            />
          </Field>

          <div className="border-t border-gray-200 pt-4 dark:border-gray-800">
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={useCustom}
                onChange={(e) => setUseCustom(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 dark:border-gray-600 dark:bg-gray-800"
              />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Use custom SMTP server</span>
            </label>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Leave off for Gmail — the host is auto-detected from the email domain.
            </p>

            {useCustom && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Host" htmlFor="host">
                  <input id="host" className={inputClass} value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
                </Field>
                <Field label="Port" htmlFor="port">
                  <input id="port" className={inputClass} value={port} onChange={(e) => setPort(e.target.value)} placeholder="465" />
                </Field>
                <label className="flex items-center gap-2.5 sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={secure}
                    onChange={(e) => setSecure(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 dark:border-gray-600 dark:bg-gray-800"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Use TLS (secure) — typically on for port 465</span>
                </label>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 pt-4 dark:border-gray-800">
            <Button type="submit" loading={saving}>
              Save settings
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={testing}
              disabled={!loaded.smtp_email && !email}
              onClick={sendTest}
            >
              Send test email
            </Button>
            {saveMsg && <span className="text-sm text-green-600 dark:text-green-400">{saveMsg}</span>}
            <ErrorText>{saveErr}</ErrorText>
          </div>

          {testResult && (
            <div
              className={`rounded-md p-3 text-sm ring-1 ring-inset ${
                testResult.ok
                  ? 'bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/20'
                  : 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20'
              }`}
            >
              {testResult.message}
            </div>
          )}
        </Card>
      </form>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">How to get a Gmail app password</h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-gray-600 dark:text-gray-400">
          <li>Enable 2-Step Verification on your Google account (required for app passwords).</li>
          <li>
            Visit{' '}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
            >
              myaccount.google.com/apppasswords
            </a>
            .
          </li>
          <li>Create a new app password and paste the 16-character value into the field above.</li>
        </ol>
      </Card>
    </div>
  );
}
