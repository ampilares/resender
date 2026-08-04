import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, Card, CopyButton, Modal, PageLoader, StatusBadge } from '../components/ui';
import FormEditor from '../components/FormEditor';
import { formatDate } from '../format';
import type { Form, FormInput } from '../types';

export default function Forms() {
  const { me } = useAuth();
  const [forms, setForms] = useState<Form[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ form: Form; key: string } | null>(null);

  const load = async () => {
    const res = await api.get<{ forms: Form[] }>('/api/admin/forms');
    setForms(res.forms);
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async (input: FormInput) => {
    const res = await api.post<{ form: Form; api_key: string }>('/api/admin/forms', input);
    setCreating(false);
    await load();
    setNewKey({ form: res.form, key: res.api_key });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">Forms</h1>
        <Button onClick={() => setCreating(true)}>New form</Button>
      </div>

      {forms === null ? (
        <PageLoader />
      ) : forms.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No forms yet. Create your first form to get an endpoint URL and integration snippet.
          </p>
          <Button className="mt-4" onClick={() => setCreating(true)}>
            New form
          </Button>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead>
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th className="px-5 py-2.5">Name</th>
                  <th className="px-5 py-2.5">Slug</th>
                  <th className="px-5 py-2.5">Destination</th>
                  <th className="px-5 py-2.5">Status</th>
                  <th className="px-5 py-2.5">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/70">
                {forms.map((f) => (
                  <tr key={f.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-5 py-3">
                      <Link to={`/forms/${f.id}`} className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                        {f.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-400">{f.slug}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{f.destination_emails.join(', ')}</td>
                    <td className="px-5 py-3">
                      {f.enabled ? (
                        <StatusBadge status="sent" label="active" />
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 ring-1 ring-inset ring-gray-500/20 dark:bg-gray-500/10 dark:text-gray-400">
                          disabled
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{formatDate(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Create form">
        <FormEditor
          submitLabel="Create form"
          onSubmit={create}
          onCancel={() => setCreating(false)}
          turnstileConfigured={Boolean(me?.turnstileConfigured)}
        />
      </Modal>

      <Modal
        open={newKey !== null}
        onClose={() => setNewKey(null)}
        title="Form created"
        footer={
          <Link to={newKey ? `/forms/${newKey.form.id}` : '#'}>
            <Button onClick={() => setNewKey(null)}>Go to form</Button>
          </Link>
        }
      >
        {newKey && <ApiKeyReveal apiKey={newKey.key} />}
      </Modal>
    </div>
  );
}

export function ApiKeyReveal({ apiKey }: { apiKey: string }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Copy your API key now. For security it is stored hashed and{' '}
        <strong className="text-gray-900 dark:text-gray-100">will not be shown again</strong>.
      </p>
      <div className="flex items-center gap-2 rounded-md bg-gray-50 p-3 ring-1 ring-inset ring-gray-200 dark:bg-gray-800 dark:ring-gray-700">
        <code className="flex-1 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{apiKey}</code>
        <CopyButton text={apiKey} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Use it as a bearer token for the programmatic <code className="font-mono">POST /api/v1/send</code> endpoint.
      </p>
    </div>
  );
}
