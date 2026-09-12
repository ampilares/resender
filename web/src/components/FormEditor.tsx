import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorText, Field, inputClass } from './ui';
import type { Form, FormInput, SmsDevice } from '../types';

const DEFAULT_SMS_TEMPLATE = 'New {{form}} submission from {{name}} {{email}} {{phone}}: {{message}}';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface Props {
  initial?: Form;
  submitLabel: string;
  onSubmit: (input: FormInput) => Promise<void>;
  onCancel?: () => void;
  turnstileConfigured?: boolean;
}

export default function FormEditor({ initial, submitLabel, onSubmit, onCancel, turnstileConfigured }: Props) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [destinations, setDestinations] = useState<string[]>(
    initial?.destination_emails?.length
      ? initial.destination_emails
      : initial?.destination_email
        ? [initial.destination_email]
        : [],
  );
  const [subject, setSubject] = useState(initial?.subject_template ?? 'New submission from {{form}}');
  const [origins, setOrigins] = useState<string[]>(initial?.allowed_origins ?? []);
  const [redirect, setRedirect] = useState(initial?.redirect_url ?? '');
  const configured = initial?.turnstile_configured ?? turnstileConfigured ?? false;
  const [turnstileEnabled, setTurnstileEnabled] = useState(initial?.turnstile_enabled ?? configured);
  const [spamThreshold, setSpamThreshold] = useState(initial?.spam_score_threshold ?? 5);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const { me } = useAuth();
  const smsConfigured = Boolean(me?.smsConfigured);
  const [smsEnabled, setSmsEnabled] = useState(initial?.sms_enabled ?? false);
  const [smsNumber, setSmsNumber] = useState(initial?.sms_number ?? '');
  const [smsTemplate, setSmsTemplate] = useState(initial?.sms_template ?? DEFAULT_SMS_TEMPLATE);
  const [smsDeviceId, setSmsDeviceId] = useState(initial?.sms_device_id ?? '');
  const [devices, setDevices] = useState<SmsDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<{ devices: SmsDevice[] }>('/api/admin/sms/devices')
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, []);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (destinations.length === 0) {
      setError('Add at least one destination email.');
      return;
    }
    if (smsEnabled && smsNumber.trim().length === 0) {
      setError('Enter a mobile number to enable SMS notifications.');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        slug: effectiveSlug || undefined,
        destination_emails: destinations,
        subject_template: subject.trim() || undefined,
        allowed_origins: origins,
        redirect_url: redirect.trim(),
        enabled,
        turnstile_enabled: turnstileEnabled,
        spam_score_threshold: spamThreshold,
        sms_enabled: smsEnabled,
        sms_number: smsNumber.trim(),
        sms_template: smsTemplate.trim() || undefined,
        sms_device_id: smsDeviceId || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save form.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Name" htmlFor="name" hint="A label to recognize this form, e.g. “allenpilares.com contact”.">
        <input
          id="name"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus={!isEdit}
        />
      </Field>

      <Field label="Slug" htmlFor="slug" hint="Used in the endpoint URL. Auto-generated from the name if left blank.">
        <input
          id="slug"
          className={`${inputClass} font-mono`}
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          placeholder="allenpilares-contact"
        />
      </Field>

      <Field
        label="Destination emails"
        hint="Every submission is delivered to all addresses. Press Enter or comma after each address."
      >
        <TagInput
          values={destinations}
          onChange={(values) => {
            setDestinations(values);
            setError(null);
          }}
          placeholder="name@example.com"
          inputType="email"
          validate={(value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)}
          invalidMessage="Enter a valid email address."
          maxValues={20}
        />
      </Field>

      <Field
        label="Subject template"
        htmlFor="subject"
        hint={
          <>
            Supports <code className="font-mono">{'{{form}}'}</code> and <code className="font-mono">{'{{subject}}'}</code>{' '}
            placeholders.
          </>
        }
      >
        <input id="subject" className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>

      <Field
        label="Allowed origins"
        hint={
          origins.length === 0
            ? 'Empty = allow submissions from any origin. Add hosts to lock it down.'
            : 'Only these origins may submit the form.'
        }
      >
        <TagInput values={origins} onChange={setOrigins} placeholder="https://allenpilares.com" />
      </Field>

      <Field label="Redirect URL" htmlFor="redirect" hint="Optional. Where non-JS HTML form posts are redirected after success.">
        <input
          id="redirect"
          type="url"
          className={inputClass}
          value={redirect}
          onChange={(e) => setRedirect(e.target.value)}
          placeholder="https://allenpilares.com/thanks"
        />
      </Field>

      <div className="rounded-md border border-gray-200 p-4 dark:border-gray-700">
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={turnstileEnabled}
            disabled={!configured && !turnstileEnabled}
            onChange={(e) => setTurnstileEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
          />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Require Cloudflare Turnstile</span>
        </label>
        <p className="mt-1.5 pl-6 text-xs text-gray-500 dark:text-gray-400">
          {configured
            ? 'Blocks submissions unless Cloudflare validates a single-use challenge token.'
            : 'Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY on the server to enable this.'}
        </p>
      </div>

      <Field
        label="Spam score threshold"
        htmlFor="spamThreshold"
        hint="1 is strict; 20 is permissive. The recommended default is 5."
      >
        <input
          id="spamThreshold"
          type="number"
          min={1}
          max={20}
          className={inputClass}
          value={spamThreshold}
          onChange={(e) => setSpamThreshold(Number(e.target.value))}
          required
        />
      </Field>

      <div className="rounded-md border border-gray-200 p-4 dark:border-gray-700">
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={smsEnabled}
            disabled={!smsConfigured && !smsEnabled}
            onChange={(e) => setSmsEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
          />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Send SMS notification</span>
        </label>
        <p className="mt-1.5 pl-6 text-xs text-gray-500 dark:text-gray-400">
          {smsConfigured ? (
            'Texts the number below from your connected phone on every accepted submission.'
          ) : (
            <>
              Add Firebase credentials and connect a phone on the{' '}
              <Link to="/sms" className="font-medium text-indigo-600 dark:text-indigo-400">
                SMS page
              </Link>{' '}
              first.
            </>
          )}
        </p>

        {smsEnabled && (
          <div className="mt-4 space-y-4 pl-6">
            <Field label="Mobile number" htmlFor="smsNumber" hint="National (0414 511 285) or international (+61…) format.">
              <input
                id="smsNumber"
                type="tel"
                className={inputClass}
                value={smsNumber}
                onChange={(e) => setSmsNumber(e.target.value)}
                placeholder="0414 511 285"
                required={smsEnabled}
              />
            </Field>

            <Field label="Send from" htmlFor="smsDevice" hint="Which connected phone sends the text.">
              <select
                id="smsDevice"
                className={inputClass}
                value={smsDeviceId}
                onChange={(e) => setSmsDeviceId(e.target.value)}
              >
                <option value="">Default phone</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.model ? ` (${d.model})` : ''}
                    {d.connected ? '' : ' — not connected'}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Message template"
              htmlFor="smsTemplate"
              hint={
                <>
                  Placeholders: <code className="font-mono">{'{{form}}'}</code>,{' '}
                  <code className="font-mono">{'{{fields}}'}</code> (all fields), or any submitted field such as{' '}
                  <code className="font-mono">{'{{name}}'}</code>, <code className="font-mono">{'{{email}}'}</code>,{' '}
                  <code className="font-mono">{'{{message}}'}</code>. Long messages are truncated.
                </>
              }
            >
              <textarea
                id="smsTemplate"
                rows={3}
                className={inputClass}
                value={smsTemplate}
                onChange={(e) => setSmsTemplate(e.target.value)}
              />
            </Field>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 dark:border-gray-600 dark:bg-gray-800"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">Enabled</span>
      </label>

      <ErrorText>{error}</ErrorText>

      <div className="flex justify-end gap-3 pt-2">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function TagInput({
  values,
  onChange,
  placeholder,
  inputType = 'text',
  validate,
  invalidMessage = 'Invalid value.',
  maxValues,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  inputType?: 'text' | 'email';
  validate?: (value: string) => boolean;
  invalidMessage?: string;
  maxValues?: number;
}) {
  const [draft, setDraft] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const add = () => {
    const candidates = draft
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (candidates.length === 0) return;
    if (validate && candidates.some((value) => !validate(value))) {
      setInputError(invalidMessage);
      return;
    }

    const next = [...values];
    for (const value of candidates) {
      if (!next.some((existing) => existing.toLowerCase() === value.toLowerCase())) next.push(value);
    }
    if (maxValues !== undefined && next.length > maxValues) {
      setInputError(`You can add up to ${maxValues} values.`);
      return;
    }
    onChange(next);
    setDraft('');
    setInputError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-white p-2 ring-1 ring-inset ring-gray-300 focus-within:ring-2 focus-within:ring-indigo-600 dark:bg-gray-800 dark:ring-gray-700">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-200"
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type={inputType}
          multiple={inputType === 'email'}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setInputError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={add}
          placeholder={values.length === 0 ? placeholder : ''}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
        />
      </div>
      {inputError && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{inputError}</p>}
    </div>
  );
}
