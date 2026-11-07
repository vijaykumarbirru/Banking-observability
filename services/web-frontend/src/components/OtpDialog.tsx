import { FormEvent, useEffect, useState } from 'react';
import { ApiError, api, istDateTime, session } from '../api';

type Sms = { message: string; createdAt: string };

/** Modal asking for a step-up OTP, with the lab-only simulated SMS inbox underneath. */
export default function OtpDialog({
  title,
  summary,
  onSubmit,
  onCancel,
}: {
  title: string;
  summary: string;
  onSubmit: (otp: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inbox, setInbox] = useState<Sms[]>([]);

  useEffect(() => {
    const customerId = session.get()?.customerId;
    if (!customerId) return;
    const poll = () =>
      api<Sms[]>(`/notifications/dev-inbox?customerId=${customerId}`)
        .then(setInbox)
        .catch(() => undefined);
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(otp);
    } catch (err) {
      const left = err instanceof ApiError ? err.details.attemptsRemaining : undefined;
      setError(`${err instanceof Error ? err.message : 'Verification failed.'}${left != null ? ` ${left} attempt(s) left.` : ''}`);
      setOtp('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <form onSubmit={submit}>
          <h3>{title}</h3>
          <p className="muted">{summary}</p>
          <label>
            Enter the OTP sent to your registered mobile
            <input
              className="otp-input"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoFocus
            />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="row-actions">
            <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || otp.length !== 6}>
              {busy ? 'Verifying…' : 'Confirm'}
            </button>
          </div>
        </form>
        <section className="dev-inbox compact">
          <header>
            <span>📱 Developer inbox</span>
            <small>Simulated SMS · lab only</small>
          </header>
          {inbox.slice(0, 2).map((m) => (
            <div className="sms" key={m.createdAt}>
              <p>{m.message}</p>
              <time>{istDateTime(m.createdAt)}</time>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
