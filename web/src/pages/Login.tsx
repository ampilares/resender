import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorText, inputClass } from '../components/ui';

interface LoginResponse {
  ok: boolean;
  defaultPassword: boolean;
}

export default function Login() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post<LoginResponse>('/api/admin/login', { password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold text-white">
            r
          </span>
          <span className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            resender
          </span>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Admin sign in</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Enter the admin password to continue.</p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`mt-1.5 ${inputClass}`}
              />
            </div>

            <ErrorText>{error}</ErrorText>

            <Button type="submit" loading={loading} className="w-full">
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
