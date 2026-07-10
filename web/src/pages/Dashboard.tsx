import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Card, PageLoader, StatusBadge } from '../components/ui';
import { formatDate } from '../format';
import type { Form, Stats, SubmissionsResponse, Submission } from '../types';

export default function Dashboard() {
  const { me } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [forms, setForms] = useState<Form[] | null>(null);
  const [recent, setRecent] = useState<Submission[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [statsRes, formsRes, subsRes] = await Promise.all([
          api.get<Stats>('/api/admin/stats'),
          api.get<{ forms: Form[] }>('/api/admin/forms'),
          api.get<SubmissionsResponse>('/api/admin/submissions?page=1'),
        ]);
        if (!active) return;
        setStats(statsRes);
        setForms(formsRes.forms);
        setRecent(subsRes.submissions.slice(0, 8));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <PageLoader />;

  const needsSetup = me?.smtpConfigured !== true || (forms?.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">Dashboard</h1>

      {needsSetup && <SetupChecklist smtpConfigured={me?.smtpConfigured === true} hasForms={(forms?.length ?? 0) > 0} />}

      {stats && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Sent (24h)" value={stats.last24h.sent} tone="green" />
          <StatCard label="Sent (30d)" value={stats.last30d.sent} tone="indigo" />
          <StatCard label="Failed (30d)" value={stats.last30d.failed} tone="red" />
          <StatCard label="Spam (30d)" value={stats.last30d.spam} tone="amber" />
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent submissions</h2>
          <Link to="/logs" className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
            View all
          </Link>
        </div>
        {recent && recent.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
              <thead>
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th className="px-5 py-2.5">Form</th>
                  <th className="px-5 py-2.5">Status</th>
                  <th className="px-5 py-2.5">Reply-to</th>
                  <th className="px-5 py-2.5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800/70">
                {recent.map((s) => (
                  <tr key={s.id}>
                    <td className="px-5 py-2.5 text-gray-700 dark:text-gray-300">{formName(forms, s.form_id)}</td>
                    <td className="px-5 py-2.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-5 py-2.5 text-gray-500 dark:text-gray-400">{s.reply_to ?? '—'}</td>
                    <td className="px-5 py-2.5 text-gray-500 dark:text-gray-400">{formatDate(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No submissions yet.</p>
        )}
      </Card>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'green' | 'indigo' | 'red' | 'amber' }) {
  const tones: Record<string, string> = {
    green: 'text-green-600 dark:text-green-400',
    indigo: 'text-indigo-600 dark:text-indigo-400',
    red: 'text-red-600 dark:text-red-400',
    amber: 'text-amber-600 dark:text-amber-400',
  };
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${tones[tone]}`}>{value}</p>
    </Card>
  );
}

function SetupChecklist({ smtpConfigured, hasForms }: { smtpConfigured: boolean; hasForms: boolean }) {
  const steps = [
    { done: smtpConfigured, label: 'Connect Gmail', to: '/settings', cta: 'Open settings' },
    { done: hasForms, label: 'Create a form', to: '/forms', cta: 'Create form' },
    { done: false, label: 'Copy the snippet into your site', to: '/forms', cta: 'View forms' },
  ];
  return (
    <Card className="border-indigo-200 bg-indigo-50/50 p-5 dark:border-indigo-500/30 dark:bg-indigo-500/5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Get started</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Finish setup to start relaying form submissions.</p>
      <ol className="mt-4 space-y-3">
        {steps.map((step, i) => (
          <li key={step.label} className="flex items-center gap-3">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                step.done
                  ? 'bg-green-600 text-white'
                  : 'bg-white text-gray-500 ring-1 ring-inset ring-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700'
              }`}
            >
              {step.done ? '✓' : i + 1}
            </span>
            <span
              className={`flex-1 text-sm ${
                step.done ? 'text-gray-400 line-through dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'
              }`}
            >
              {step.label}
            </span>
            {!step.done && (
              <Link
                to={step.to}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
              >
                {step.cta} →
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function formName(forms: Form[] | null, id: string): string {
  return forms?.find((f) => f.id === id)?.name ?? id;
}
