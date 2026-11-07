import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, post } from '../api';
import Brand from '../components/Brand';

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [customerId, setCustomerId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const id = customerId.trim().toUpperCase();
      const res = await post<{ loginToken: string; otpExpiresInSeconds: number }>('/auth/login', { customerId: id, password });
      navigate('/login/otp', { state: { customerId: id, loginToken: res.loginToken, expiresIn: res.otpExpiresInSeconds } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS' && typeof err.details.attemptsRemaining === 'number') {
        setError(`${err.message} ${err.details.attemptsRemaining} attempt(s) left before your login is locked.`);
      } else {
        setError(err instanceof Error ? err.message : 'Login failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <aside className="auth-hero">
        <Brand light />
        <h1>Banking that keeps up with you.</h1>
        <p>Check balances, move money and pay bills — securely, any time.</p>
        <ul className="hero-points">
          <li>Two-step login with OTP</li>
          <li>Instant IMPS, NEFT and RTGS transfers</li>
          <li>Statements you can download</li>
        </ul>
      </aside>
      <main className="auth-card-wrap">
        <form className="card auth-card" onSubmit={submit}>
          <h2>Log in to Net Banking</h2>
          {params.get('reason') === 'idle' && <div className="notice">You were logged out after 5 minutes of inactivity.</div>}
          {params.get('reason') === 'logout' && <div className="notice">You have logged out securely.</div>}
          <label>
            Customer ID
            <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="e.g. VB100001" autoFocus required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <p className="hint">Demo customers: VB100001 – VB100020 · password Welcome@123</p>
          <p className="fineprint">VijayBank is a fictional bank built for learning. Never enter real banking credentials here.</p>
        </form>
      </main>
    </div>
  );
}
