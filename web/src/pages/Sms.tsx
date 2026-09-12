import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Button, Card, CopyButton, ErrorText, Field, inputClass, Modal, PageLoader, StatusBadge } from '../components/ui';
import { formatDate } from '../format';
import type { SmsDevice, SmsMessage, SmsMessagesResponse, SmsSettings } from '../types';

export default function Sms() {
  const { refresh } = useAuth();
  const [settings, setSettings] = useState<SmsSettings | null>(null);
  const [devices, setDevices] = useState<SmsDevice[] | null>(null);
  const [messagesVersion, setMessagesVersion] = useState(0);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([
      api.get<SmsSettings>('/api/admin/sms/settings'),
      api.get<{ devices: SmsDevice[] }>('/api/admin/sms/devices'),
    ]);
    setSettings(s);
    setDevices(d.devices);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Anything that can change "ready" also updates the auth probe used by FormEditor / Dashboard.
  const changed = useCallback(async () => {
    await load();
    await refresh();
  }, [load, refresh]);

  if (!settings || !devices) return <PageLoader />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">SMS</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Forms can text a mobile number on every accepted submission. Messages are sent by an Android phone running the
          SMS gateway app, pushed from here over Firebase Cloud Messaging.
        </p>
      </div>

      {!settings.ready && (
        <Card className="border-indigo-200 bg-indigo-50/50 p-5 dark:border-indigo-500/30 dark:bg-indigo-500/5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Set up in three steps</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
            <li className={settings.firebase_configured ? 'text-gray-400 line-through dark:text-gray-500' : ''}>
              Paste the service-account JSON of the Firebase project your gateway app was built with.
            </li>
            <li className={settings.devices_registered > 0 ? 'text-gray-400 line-through dark:text-gray-500' : ''}>
              Add a phone below, install the gateway app on it, and register it with the key shown.
            </li>
            <li>Send a test SMS, then enable SMS notifications on a form.</li>
          </ol>
        </Card>
      )}

      <FirebaseCard settings={settings} onChange={changed} />
      <DefaultsCard settings={settings} onChange={load} />
      <PhonesCard devices={devices} onChange={changed} />
      <TestCard devices={devices} ready={settings.ready} onSent={() => setMessagesVersion((v) => v + 1)} />
      <MessagesCard devices={devices} version={messagesVersion} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function FirebaseCard({ settings, onChange }: { settings: SmsSettings; onChange: () => Promise<void> }) {
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(!settings.firebase_configured);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setJson(await file.text());
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      await api.post('/api/admin/sms/settings', { service_account_json: json });
      setJson('');
      if (fileRef.current) fileRef.current.value = '';
      setMsg('Firebase credentials saved.');
      setEditing(false);
      await onChange();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : 'Could not save credentials.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.delete('/api/admin/sms/settings/firebase');
      setMsg('Firebase credentials removed.');
      setEditing(true);
      await onChange();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : 'Could not remove credentials.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Firebase service account</h2>
        {settings.firebase_configured && (
          <StatusBadge status="sent" label={`connected · ${settings.firebase_project_id ?? ''}`} />
        )}
      </div>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Firebase Console → Project settings → Service accounts → <em>Generate new private key</em>. It must be the same
        project as the <code className="font-mono">google-services.json</code> baked into your gateway app build.
      </p>

      {settings.firebase_error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">Stored credentials are invalid: {settings.firebase_error}</p>
      )}

      {settings.firebase_configured && !editing ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-700 dark:text-gray-300">
            <span className="text-gray-500 dark:text-gray-400">Project</span>{' '}
            <code className="font-mono">{settings.firebase_project_id}</code>
          </span>
          <span className="text-gray-700 dark:text-gray-300">
            <span className="text-gray-500 dark:text-gray-400">Service account</span>{' '}
            <code className="font-mono">{settings.firebase_client_email}</code>
          </span>
          <span className="flex-1" />
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button variant="danger" loading={saving} onClick={remove}>
            Remove
          </Button>
        </div>
      ) : (
        <form onSubmit={save} className="mt-4 space-y-3">
          <Field label="Service account JSON" htmlFor="saJson" hint="Paste the file contents, or choose the downloaded .json file.">
            <textarea
              id="saJson"
              rows={6}
              className={`${inputClass} font-mono text-xs`}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…" }'
            />
          </Field>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} className="text-sm text-gray-600 dark:text-gray-400" />
          <div className="flex items-center gap-3">
            <Button type="submit" loading={saving} disabled={json.trim().length === 0}>
              Save credentials
            </Button>
            {settings.firebase_configured && (
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {msg && <p className="mt-3 text-sm text-green-600 dark:text-green-400">{msg}</p>}
      <ErrorText>{err}</ErrorText>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DefaultsCard({ settings, onChange }: { settings: SmsSettings; onChange: () => Promise<void> }) {
  const [countryCode, setCountryCode] = useState(settings.default_country_code);
  const [maxLength, setMaxLength] = useState(String(settings.max_length));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      await api.post('/api/admin/sms/settings', { default_country_code: countryCode, max_length: Number(maxLength) });
      setMsg('Defaults saved.');
      await onChange();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Defaults</h2>
      <form onSubmit={save} className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Default country code" htmlFor="cc" hint="Applied to numbers entered in national format (04…).">
          <input id="cc" className={inputClass} value={countryCode} onChange={(e) => setCountryCode(e.target.value)} placeholder="+61" />
        </Field>
        <Field label="Max message length" htmlFor="maxLen" hint="Characters. 160 = one segment, 320 ≈ two.">
          <input
            id="maxLen"
            type="number"
            min={40}
            max={1000}
            className={inputClass}
            value={maxLength}
            onChange={(e) => setMaxLength(e.target.value)}
          />
        </Field>
        <div className="flex items-end gap-3">
          <Button type="submit" loading={saving}>
            Save defaults
          </Button>
          {msg && <span className="pb-2 text-sm text-green-600 dark:text-green-400">{msg}</span>}
        </div>
      </form>
      <ErrorText>{err}</ErrorText>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function PhonesCard({ devices, onChange }: { devices: SmsDevice[]; onChange: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ device: SmsDevice; key: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'regenerate'; device: SmsDevice } | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ device: SmsDevice; api_key: string }>('/api/admin/sms/devices', { name: name.trim() });
      setAdding(false);
      setName('');
      await onChange();
      setReveal({ device: res.device, key: res.api_key });
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : 'Could not add phone.');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (device: SmsDevice, body: Partial<Pick<SmsDevice, 'enabled' | 'is_default'>>) => {
    await api.patch(`/api/admin/sms/devices/${device.id}`, body);
    await onChange();
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'delete') {
        await api.delete(`/api/admin/sms/devices/${confirm.device.id}`);
        setConfirm(null);
        await onChange();
      } else {
        const res = await api.post<{ api_key: string; device: SmsDevice }>(
          `/api/admin/sms/devices/${confirm.device.id}/regenerate-key`,
        );
        setConfirm(null);
        await onChange();
        setReveal({ device: res.device, key: res.api_key });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Phones</h2>
        <Button onClick={() => setAdding(true)}>Add phone</Button>
      </div>
      {devices.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No phones yet. Add one to get a registration key for the gateway app.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="px-5 py-2.5">Name</th>
                <th className="px-5 py-2.5">Device</th>
                <th className="px-5 py-2.5">Status</th>
                <th className="px-5 py-2.5">Last seen</th>
                <th className="px-5 py-2.5">Key</th>
                <th className="px-5 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800/70">
              {devices.map((d) => (
                <tr key={d.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-5 py-3 font-medium text-gray-900 dark:text-gray-100">
                    {d.name}
                    {d.is_default && (
                      <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                        default
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-400">
                    {d.model ? `${d.manufacturer ?? d.brand ?? ''} ${d.model}`.trim() : '—'}
                    {d.app_version_name && <span className="ml-1 text-xs text-gray-400">app {d.app_version_name}</span>}
                  </td>
                  <td className="px-5 py-3">
                    {!d.enabled ? (
                      <StatusBadge status="rate_limited" label="disabled" />
                    ) : d.connected ? (
                      <StatusBadge status="sent" label="connected" />
                    ) : d.registered ? (
                      <StatusBadge status="failed" label="disconnected" />
                    ) : (
                      <StatusBadge status="pending" label="awaiting registration" />
                    )}
                  </td>
                  <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{d.last_seen_at ? formatDate(d.last_seen_at) : '—'}</td>
                  <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{d.api_key_prefix}…</td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {!d.is_default && (
                        <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => patch(d, { is_default: true })}>
                          Make default
                        </Button>
                      )}
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => patch(d, { enabled: !d.enabled })}>
                        {d.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setConfirm({ kind: 'regenerate', device: d })}>
                        New key
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs text-red-600 dark:text-red-400" onClick={() => setConfirm({ kind: 'delete', device: d })}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add phone">
        <form onSubmit={add} className="space-y-4">
          <Field label="Name" htmlFor="phoneName" hint="A label for this phone, e.g. “Office Pixel”.">
            <input id="phoneName" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <ErrorText>{err}</ErrorText>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create key
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={reveal !== null}
        onClose={() => setReveal(null)}
        title={reveal ? `Register “${reveal.device.name}”` : ''}
        footer={<Button onClick={() => setReveal(null)}>Done</Button>}
      >
        {reveal && <DeviceKeyReveal apiKey={reveal.key} />}
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'delete' ? 'Delete phone?' : 'Generate a new key?'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant={confirm?.kind === 'delete' ? 'danger' : 'primary'} loading={busy} onClick={runConfirm}>
              {confirm?.kind === 'delete' ? 'Delete phone' : 'Generate key'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {confirm?.kind === 'delete'
            ? `Removes ${confirm.device.name}. Forms using it fall back to the default phone; message history is kept.`
            : `The current key stops working immediately and the phone will need to be registered again with the new key.`}
        </p>
      </Modal>
    </Card>
  );
}

function DeviceKeyReveal({ apiKey }: { apiKey: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const baseUrl = `${window.location.origin}/api/v1/`;

  useEffect(() => {
    QRCode.toDataURL(apiKey, { width: 200, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [apiKey]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Copy this key now — it is stored hashed and{' '}
        <strong className="text-gray-900 dark:text-gray-100">will not be shown again</strong>.
      </p>
      <div className="flex items-center gap-2 rounded-md bg-gray-50 p-3 ring-1 ring-inset ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
        <code className="flex-1 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{apiKey}</code>
        <CopyButton text={apiKey} />
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        {qr && (
          <img src={qr} alt="QR code of the device key" className="h-[200px] w-[200px] shrink-0 rounded-md bg-white p-1 ring-1 ring-gray-200" />
        )}
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-gray-700 dark:text-gray-300">
          <li>Install the SMS gateway app on the phone and grant the SMS permissions.</li>
          <li>
            Set its <strong>API Base URL</strong> to{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-gray-800">{baseUrl}</code>{' '}
            <CopyButton text={baseUrl} label="Copy URL" className="ml-1" />
          </li>
          <li>Scan the QR code (or paste the key) and tap <strong>Register</strong>.</li>
          <li>Turn the gateway switch on. The phone shows as connected here within a few seconds.</li>
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TestCard({ devices, ready, onSent }: { devices: SmsDevice[]; ready: boolean; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [tracking, setTracking] = useState<SmsMessage | null>(null);

  useEffect(() => {
    if (!tracking || ['delivered', 'failed', 'delivery_failed'].includes(tracking.status)) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const res = await api.get<{ message: SmsMessage }>(`/api/admin/sms/messages/${tracking.id}`);
        setTracking(res.message);
      } catch {
        clearInterval(timer);
      }
      if (Date.now() - started > 60_000) clearInterval(timer);
    }, 2000);
    return () => clearInterval(timer);
  }, [tracking]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setResult(null);
    setTracking(null);
    try {
      const res = await api.post<{ ok: boolean; id: string; status: string; to: string }>('/api/admin/sms/test', {
        to,
        device_id: deviceId || undefined,
      });
      setResult({ ok: true, text: `Pushed to the phone for ${res.to}. Waiting for the carrier status…` });
      const msg = await api.get<{ message: SmsMessage }>(`/api/admin/sms/messages/${res.id}`);
      setTracking(msg.message);
      onSent();
    } catch (error) {
      setResult({ ok: false, text: error instanceof ApiError ? error.message : 'Could not send test SMS.' });
      onSent();
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Send a test SMS</h2>
      <form onSubmit={send} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <Field label="Mobile number" htmlFor="testTo">
            <input id="testTo" type="tel" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} placeholder="0414 511 285" required />
          </Field>
        </div>
        <div className="min-w-[12rem]">
          <Field label="From phone" htmlFor="testDevice">
            <select id="testDevice" className={inputClass} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Default phone</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" loading={sending} disabled={!ready}>
          Send test
        </Button>
      </form>
      {!ready && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Add Firebase credentials and connect a phone first.</p>
      )}
      {result && (
        <p className={`mt-3 text-sm ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{result.text}</p>
      )}
      {tracking && (
        <p className="mt-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          Carrier status: <StatusBadge status={tracking.status} />
          {tracking.error_message && <span className="text-red-600 dark:text-red-400">{tracking.error_message}</span>}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function MessagesCard({ devices, version }: { devices: SmsDevice[]; version: number }) {
  const [data, setData] = useState<SmsMessagesResponse | null>(null);
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (direction) params.set('direction', direction);
    if (status) params.set('status', status);
    if (deviceId) params.set('device_id', deviceId);
    params.set('page', String(page));
    api.get<SmsMessagesResponse>(`/api/admin/sms/messages?${params.toString()}`).then(setData);
  }, [direction, status, deviceId, page, version]);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Messages</h2>
        <div className="flex flex-wrap gap-2">
          <select className={`${inputClass} w-auto !py-1.5 text-xs`} value={direction} onChange={(e) => { setPage(1); setDirection(e.target.value); }}>
            <option value="">Sent & received</option>
            <option value="outbound">Sent</option>
            <option value="inbound">Received</option>
          </select>
          <select className={`${inputClass} w-auto !py-1.5 text-xs`} value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">All statuses</option>
            {['queued', 'sent', 'delivered', 'failed', 'delivery_failed', 'received'].map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <select className={`${inputClass} w-auto !py-1.5 text-xs`} value={deviceId} onChange={(e) => { setPage(1); setDeviceId(e.target.value); }}>
            <option value="">All phones</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!data ? (
        <PageLoader />
      ) : data.messages.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No messages yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="px-5 py-2.5 w-8"></th>
                <th className="px-5 py-2.5">When</th>
                <th className="px-5 py-2.5">Direction</th>
                <th className="px-5 py-2.5">Number</th>
                <th className="px-5 py-2.5">Message</th>
                <th className="px-5 py-2.5">Status</th>
                <th className="px-5 py-2.5">Phone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800/70">
              {data.messages.map((m) => (
                <Fragment key={m.id}>
                  <tr className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50" onClick={() => setExpanded(expanded === m.id ? null : m.id)}>
                    <td className="px-5 py-3 text-gray-400">
                      <span className={`inline-block transition-transform ${expanded === m.id ? 'rotate-90' : ''}`}>▶</span>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(m.created_at)}</td>
                    <td className="px-5 py-3 text-gray-700 dark:text-gray-300">{m.direction === 'outbound' ? 'Sent' : 'Received'}</td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">{m.direction === 'outbound' ? m.recipient : m.sender}</td>
                    <td className="max-w-md truncate px-5 py-3 text-gray-700 dark:text-gray-300">{m.message}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{m.device_name ?? '—'}</td>
                  </tr>
                  {expanded === m.id && (
                    <tr className="bg-gray-50 dark:bg-gray-800/40">
                      <td colSpan={7} className="px-5 py-4">
                        <div className="space-y-2 text-sm">
                          {m.error_message && (
                            <div className="rounded-md bg-red-50 p-3 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20">
                              <span className="font-semibold">Error{m.error_code ? ` (${m.error_code})` : ''}:</span> {m.error_message}
                            </div>
                          )}
                          <pre className="whitespace-pre-wrap rounded-md bg-gray-900 p-3 text-xs leading-relaxed text-gray-100 dark:bg-black/40">{m.message}</pre>
                          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                            {m.form_name && <span>Form: <strong className="text-gray-700 dark:text-gray-200">{m.form_name}</strong></span>}
                            {m.requested_at && <span>Requested: {formatDate(m.requested_at)}</span>}
                            {m.sent_at && <span>Sent: {formatDate(m.sent_at)}</span>}
                            {m.delivered_at && <span>Delivered: {formatDate(m.delivered_at)}</span>}
                            {m.failed_at && <span>Failed: {formatDate(m.failed_at)}</span>}
                            {m.received_at && <span>Received: {formatDate(m.received_at)}</span>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3 text-sm dark:border-gray-800">
          <span className="text-gray-500 dark:text-gray-400">
            Page {data.page} of {data.totalPages} · {data.total} total
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="secondary" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
