import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, PageLoader, StatusBadge, inputClass } from '../components/ui';
import { formatDate } from '../format';
import type { Form, SubmissionsResponse, Submission, SubmissionStatus } from '../types';

const STATUSES: SubmissionStatus[] = ['sent', 'failed', 'spam', 'rate_limited'];

export default function Logs() {
  const [forms, setForms] = useState<Form[]>([]);
  const [data, setData] = useState<SubmissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [formId, setFormId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ forms: Form[] }>('/api/admin/forms').then((r) => setForms(r.forms));
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (formId) params.set('form_id', formId);
    if (status) params.set('status', status);
    params.set('page', String(page));
    api
      .get<SubmissionsResponse>(`/api/admin/submissions?${params.toString()}`)
      .then((r) => setData(r))
      .finally(() => setLoading(false));
  }, [formId, status, page]);

  const formName = (id: string) => forms.find((f) => f.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">Logs</h1>

      <div className="flex flex-wrap gap-3">
        <select
          className={`${inputClass} w-auto`}
          value={formId}
          onChange={(e) => {
            setPage(1);
            setFormId(e.target.value);
          }}
        >
          <option value="">All forms</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          className={`${inputClass} w-auto`}
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'rate_limited' ? 'rate limited' : s}
            </option>
          ))}
        </select>
      </div>

      <Card>
        {loading && !data ? (
          <PageLoader />
        ) : data && data.submissions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead>
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th className="px-5 py-2.5 w-8"></th>
                  <th className="px-5 py-2.5">Form</th>
                  <th className="px-5 py-2.5">Status</th>
                  <th className="px-5 py-2.5">Score</th>
                  <th className="px-5 py-2.5">Reply-to</th>
                  <th className="px-5 py-2.5">IP</th>
                  <th className="px-5 py-2.5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/70">
                {data.submissions.map((s) => (
                  <Fragment key={s.id}>
                    <tr
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                      onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    >
                      <td className="px-5 py-3 text-gray-400">
                        <span className={`inline-block transition-transform ${expanded === s.id ? 'rotate-90' : ''}`}>
                          ▶
                        </span>
                      </td>
                      <td className="px-5 py-3 text-gray-700 dark:text-gray-300">{formName(s.form_id)}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{s.spam_score}</td>
                      <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{s.reply_to ?? '—'}</td>
                      <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{s.ip ?? '—'}</td>
                      <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{formatDate(s.created_at)}</td>
                    </tr>
                    {expanded === s.id && (
                      <tr className="bg-gray-50 dark:bg-gray-800/40">
                        <td colSpan={7} className="px-5 py-4">
                          <ExpandedRow submission={s} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">No submissions match these filters.</p>
        )}
      </Card>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
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
    </div>
  );
}

function ExpandedRow({ submission }: { submission: Submission }) {
  return (
    <div className="space-y-3">
      {submission.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20">
          <span className="font-semibold">Error:</span> {submission.error}
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        <span>Spam score: <strong className="text-gray-700 dark:text-gray-200">{submission.spam_score}</strong></span>
        <span>Turnstile: <strong className="text-gray-700 dark:text-gray-200">{submission.turnstile_status ?? 'not recorded'}</strong></span>
      </div>
      {submission.spam_reasons.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Scoring signals</p>
          <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
            {submission.spam_reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`}>
                <span className="font-mono text-xs text-amber-700 dark:text-amber-400">+{reason.points}</span>{' '}
                {reason.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Payload</p>
        <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs leading-relaxed text-gray-100 dark:bg-black/40">
          <code>{JSON.stringify(submission.payload, null, 2)}</code>
        </pre>
      </div>
      {submission.message_id && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Message ID: <code className="font-mono">{submission.message_id}</code>
        </p>
      )}
    </div>
  );
}
