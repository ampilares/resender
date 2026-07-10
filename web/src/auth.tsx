import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (me: Me) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<Me>('/api/admin/me', { noRedirect: true });
      setMeState(data);
    } catch {
      setMeState({ authenticated: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/admin/logout');
    } catch {
      // ignore
    }
    setMeState({ authenticated: false });
  }, []);

  const setMe = useCallback((next: Me) => setMeState(next), []);

  return (
    <AuthContext.Provider value={{ me, loading, refresh, setMe, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
