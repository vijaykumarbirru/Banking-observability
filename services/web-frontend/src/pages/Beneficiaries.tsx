import { FormEvent, useEffect, useState } from 'react';
import { ApiError, api, istDateTime, post } from '../api';
import Layout from '../components/Layout';
import OtpDialog from '../components/OtpDialog';
import { Beneficiary } from '../types';

export default function Beneficiaries() {
  const [list, setList] = useState<Beneficiary[]>([]);
  const [form, setForm] = useState({ name: '', accountNo: '', confirmAccountNo: '', ifsc: '', nickname: '' });
  const [pending, setPending] = useState<Beneficiary | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<Beneficiary[]>('/beneficiaries').then(setList);
  useEffect(() => {
    load();
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (form.accountNo !== form.confirmAccountNo) {
      setError('Account numbers do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await post<{ beneficiary: Beneficiary }>('/beneficiaries', {
        name: form.name,
        accountNo: form.accountNo,
        ifsc: form.ifsc.toUpperCase(),
        nickname: form.nickname || null,
      });
      setPending(res.beneficiary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add beneficiary.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmOtp(otp: string) {
    try {
      const b = await post<Beneficiary>(`/beneficiaries/${pending!.beneficiaryId}/confirm`, { otp });
      setPending(null);
      setForm({ name: '', accountNo: '', confirmAccountNo: '', ifsc: '', nickname: '' });
      setNotice(`${b.name} added. For your security you can send money from ${istDateTime(b.activatesAt!)}.`);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') throw err;
      setPending(null);
      setError(err instanceof Error ? err.message : 'Could not add beneficiary.');
    }
  }

  async function remove(b: Beneficiary) {
    if (!window.confirm(`Delete ${b.name}?`)) return;
    await api(`/beneficiaries/${b.beneficiaryId}`, { method: 'DELETE' });
    load();
  }

  return (
    <Layout title="Beneficiaries" subtitle="People and businesses you send money to">
      <div className="grid-2">
        <div className="card">
          <h3>Saved beneficiaries</h3>
          {list.length === 0 ? (
            <p className="muted">No beneficiaries yet.</p>
          ) : (
            <ul className="history">
              {list.map((b) => (
                <li key={b.beneficiaryId}>
                  <div>
                    <strong>{b.name}</strong>
                    <small className="muted">
                      {b.bankName} · {b.accountNoMasked} · {b.ifsc}
                      {b.nickname ? ` · ${b.nickname}` : ''}
                    </small>
                  </div>
                  <div className="right">
                    {b.canReceive ? (
                      <span className="status completed">active</span>
                    ) : (
                      <span className="status processing" title="Cooling period after adding">
                        from {b.activatesAt && istDateTime(b.activatesAt)}
                      </span>
                    )}
                    <button className="btn-link small-btn" onClick={() => remove(b)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form className="card" onSubmit={submit}>
          <h3>Add a beneficiary</h3>
          <label>
            Beneficiary name
            <input value={form.name} onChange={set('name')} required />
          </label>
          <label>
            Account number
            <input value={form.accountNo} onChange={set('accountNo')} inputMode="numeric" required />
          </label>
          <label>
            Re-enter account number
            <input value={form.confirmAccountNo} onChange={set('confirmAccountNo')} inputMode="numeric" required />
          </label>
          <label>
            IFSC
            <input value={form.ifsc} onChange={set('ifsc')} placeholder="e.g. BCBK0000123" required />
          </label>
          <label>
            Nickname <span className="muted">(optional)</span>
            <input value={form.nickname} onChange={set('nickname')} />
          </label>
          {error && <div className="error">{error}</div>}
          {notice && <div className="notice">{notice}</div>}
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Checking…' : 'Add beneficiary'}
          </button>
          <p className="hint">New beneficiaries become active after a 30-minute cooling period, and can receive up to ₹50,000 in the first 24 hours.</p>
        </form>
      </div>

      {pending && (
        <OtpDialog
          title="Confirm new beneficiary"
          summary={`${pending.name} · ${pending.bankName} ${pending.accountNoMasked}`}
          onSubmit={confirmOtp}
          onCancel={() => setPending(null)}
        />
      )}
    </Layout>
  );
}
