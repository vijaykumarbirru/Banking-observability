import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { session } from './api';
import Login from './pages/Login';
import Otp from './pages/Otp';
import Dashboard from './pages/Dashboard';
import Transfers from './pages/Transfers';
import Beneficiaries from './pages/Beneficiaries';
import Statements from './pages/Statements';

const IDLE_LIMIT_MS = 5 * 60 * 1000;

/** Logs the customer out after 5 minutes without any interaction. */
function useIdleLogout() {
  const navigate = useNavigate();
  useEffect(() => {
    let last = Date.now();
    const touch = () => (last = Date.now());
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = setInterval(() => {
      if (session.get() && Date.now() - last > IDLE_LIMIT_MS) {
        session.clear();
        navigate('/login?reason=idle', { replace: true });
      }
    }, 10_000);
    return () => {
      clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [navigate]);
}

function RequireSession({ children }: { children: JSX.Element }) {
  return session.get() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  useIdleLogout();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/login/otp" element={<Otp />} />
      <Route
        path="/dashboard"
        element={
          <RequireSession>
            <Dashboard />
          </RequireSession>
        }
      />
      {[
        ['/transfers', <Transfers />],
        ['/beneficiaries', <Beneficiaries />],
        ['/statements', <Statements />],
      ].map(([path, el]) => (
        <Route key={path as string} path={path as string} element={<RequireSession>{el as JSX.Element}</RequireSession>} />
      ))}
      <Route path="*" element={<Navigate to={session.get() ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
