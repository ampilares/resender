import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { PageLoader } from './components/ui';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Forms from './pages/Forms';
import FormDetail from './pages/FormDetail';
import Settings from './pages/Settings';
import Logs from './pages/Logs';

export default function App() {
  const { me, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <PageLoader />
      </div>
    );
  }

  const authed = me?.authenticated === true;

  if (!authed) {
    // Unauthenticated: only the login route is reachable.
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/forms" element={<Forms />} />
        <Route path="/forms/:id" element={<FormDetail />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
