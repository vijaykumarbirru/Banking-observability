import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, post } from '../api';
import AuthShell, { Icon } from '../components/AuthShell';

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [customerId, setCustomerId] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
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
    <AuthShell>
      <form className="card login-card" onSubmit={submit}>
        <div className="login-tabs">
          <span className="active">Net Banking</span>
          <span className="disabled" title="Coming soon">
            Corporate
          </span>
        </div>
        <h2>Welcome back</h2>
        <p className="muted small">Log in securely to your VijayBank account</p>
        {params.get('reason') === 'idle' && <div className="notice">You were logged out after 5 minutes of inactivity.</div>}
        {params.get('reason') === 'logout' && <div className="notice">You have logged out securely. Thank you for banking with us.</div>}
        <label>
          Customer ID
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="e.g. VB100001" autoFocus required autoComplete="username" />
        </label>
        <label>
          <span className="label-row">
            Password
            <button type="button" className="link-btn" onClick={() => setShow(!show)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </span>
          <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
        <div className="login-links">
          <a title="Demo only">Forgot password?</a>
          <a title="Demo only">Register for net banking</a>
        </div>
        <div className="secure-note">
          <Icon name="lock" size={16} />
          <span>Two-step login with OTP · auto logout after 5 minutes idle</span>
        </div>
        <p className="hint">Demo customers: VB100001 – VB100020 · password Welcome@123</p>
      </form>
    </AuthShell>
  );
}
