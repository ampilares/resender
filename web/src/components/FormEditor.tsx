import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button, ErrorText, Field, inputClass } from './ui';
import type { Form, FormInput } from '../types';

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
}

export default function FormEditor({ initial, submitLabel, onSubmit, onCancel }: Props) {
  const isEdit = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [destination, setDestination] = useState(initial?.destination_email ?? '');
  const [subject, setSubject] = useState(initial?.subject_template ?? 'New submission from {{form}}');
  const [origins, setOrigins] = useState<string[]>(initial?.allowed_origins ?? []);
  const [redirect, setRedirect] = useState(initial?.redirect_url ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        slug: effectiveSlug || undefined,
        destination_email: destination.trim(),
        subject_template: subject.trim() || undefined,
        allowed_origins: origins,
        redirect_url: redirect.trim(),
        enabled,
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

      <Field label="Destination email" htmlFor="destination" hint="Where submissions are delivered.">
        <input
          id="destination"
          type="email"
          className={inputClass}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          required
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
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
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
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder={values.length === 0 ? placeholder : ''}
        className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
      />
    </div>
  );
}
