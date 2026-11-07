import { FormEvent, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, istDateTime, post, session } from '../api';
import AuthShell from '../components/AuthShell';

type State = { customerId: string; loginToken: string; expiresIn: number };
type Sms = { message: string; createdAt: string };

export default function Otp() {
  const navigate = useNavigate();
  const state = useLocation().state as State | null;
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inbox, setInbox] = useState<Sms[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(state?.expiresIn ?? 0);

  useEffect(() => {
    if (!state) return;
    const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    const poll = async () => {
      try {
        setInbox(await api<Sms[]>(`/notifications/dev-inbox?customerId=${state.customerId}`));
      } catch {
        /* inbox is a lab convenience; ignore failures */
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(timer);
    };
  }, [state]);

  if (!state) return <Navigate to="/login" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const tokens = await post<{ accessToken: string; refreshToken: string; customerId: string; expiresInSeconds: number }>(
        '/auth/otp/verify',
        { loginToken: state!.loginToken, otp: otp.trim() },
      );
      session.save(tokens);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'OTP_EXPIRED' || err.code === 'OTP_ATTEMPTS_EXCEEDED')) {
        navigate('/login', { replace: true });
        return;
      }
      const left = err instanceof ApiError ? err.details.attemptsRemaining : undefined;
      setError(`${err instanceof Error ? err.message : 'Verification failed.'}${typeof left === 'number' ? ` ${left} attempt(s) left.` : ''}`);
    } finally {
      setBusy(false);
    }
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <AuthShell>
      <form className="card login-card" onSubmit={submit}>
        <h2>Verify it's you</h2>
        <p className="muted small">
          We sent a 6-digit OTP to your registered mobile number · Customer ID {state.customerId}
        </p>
        <label>
          <span className="label-row">
            One-time password
            <span className={secondsLeft < 60 ? 'timer warn' : 'timer'}>
              {mm}:{ss}
            </span>
          </span>
          <input
            className="otp-input"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn-primary" disabled={busy || otp.length !== 6 || secondsLeft === 0}>
          {busy ? 'Verifying…' : 'Verify and log in'}
        </button>
        <button type="button" className="btn-link" onClick={() => navigate('/login')}>
          Back to login
        </button>
      </form>

      <section className="dev-inbox">
        <header>
          <span>📱 Developer inbox</span>
          <small>Simulated SMS · lab only</small>
        </header>
        {inbox.length === 0 ? (
          <p className="muted">Waiting for the SMS…</p>
        ) : (
          inbox.slice(0, 2).map((m) => (
            <div className="sms" key={m.createdAt}>
              <p>{m.message}</p>
              <time>{istDateTime(m.createdAt)}</time>
            </div>
          ))
        )}
      </section>
    </AuthShell>
  );
}
