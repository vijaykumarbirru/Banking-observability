import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ApiError, api, istDateTime, post, rupees, toPaise } from '../api';
import Layout from '../components/Layout';
import OtpDialog from '../components/OtpDialog';
import { Account, Beneficiary, MODE_LABEL, REASON_LABEL, Transfer } from '../types';

type Tab = 'OWN' | 'INTRA' | 'OTHER';
type Limits = { dailyLimitPaise: number; usedTodayPaise: number; remainingTodayPaise: number };
const FINAL = ['COMPLETED', 'FAILED', 'BLOCKED'];

export default function Transfers() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [history, setHistory] = useState<Transfer[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);

  const [tab, setTab] = useState<Tab>('INTRA');
  const [network, setNetwork] = useState<'IMPS' | 'NEFT' | 'RTGS'>('IMPS');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [beneficiaryId, setBeneficiaryId] = useState('');
  const [amount, setAmount] = useState('');
  const [remarks, setRemarks] = useState('');
  // One key per intended transfer: a double click or retry can never send money twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const [pending, setPending] = useState<Transfer | null>(null);
  const [result, setResult] = useState<Transfer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    api<Account[]>('/accounts').then((a) => {
      setAccounts(a);
      setFrom((f) => f || a[0]?.accountNo || '');
    });
    api<Transfer[]>('/transfers?limit=10').then(setHistory);
    api<Limits>('/transfers/limits').then(setLimits);
  };

  useEffect(() => {
    refresh();
    api<Beneficiary[]>('/beneficiaries').then(setBeneficiaries);
  }, []);

  const choices = useMemo(
    () => beneficiaries.filter((b) => (tab === 'INTRA' ? b.type === 'INTERNAL' : b.type === 'EXTERNAL')),
    [beneficiaries, tab],
  );
  const mode = tab === 'OTHER' ? network : tab;
  const fromAccount = accounts.find((a) => a.accountNo === from);

  function resetForm() {
    setAmount('');
    setRemarks('');
    setIdempotencyKey(crypto.randomUUID());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    const amountPaise = toPaise(amount);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    setBusy(true);
    try {
      const t = await post<Transfer>(
        '/transfers',
        { fromAccountNo: from, mode, amountPaise, remarks: remarks || null, ...(tab === 'OWN' ? { toAccountNo: to } : { beneficiaryId }) },
        { 'Idempotency-Key': idempotencyKey },
      );
      if (t.status === 'OTP_REQUIRED') setPending(t);
      else setResult(t); // same key replayed: show what already happened
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(otp: string) {
    try {
      let t = await post<Transfer>(`/transfers/${pending!.transferId}/confirm`, { otp });
      setPending(null);
      setResult(t);
      resetForm();
      // External transfers settle asynchronously: follow the status until it is final.
      for (let i = 0; i < 40 && !FINAL.includes(t.status); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        t = await api<Transfer>(`/transfers/${t.transferId}`);
        setResult(t);
      }
      refresh();
    } catch (err) {
      if (err instanceof ApiError && ['INVALID_OTP'].includes(err.code)) throw err;
      setPending(null);
      resetForm();
      setError(err instanceof Error ? err.message : 'Transfer failed.');
      refresh();
    }
  }

  return (
    <Layout>
      <h1>Fund transfer</h1>
      <div className="grid-2">
        <form className="card" onSubmit={submit}>
          <div className="tabs">
            {(['OWN', 'INTRA', 'OTHER'] as Tab[]).map((t) => (
              <button type="button" key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setBeneficiaryId(''); }}>
                {t === 'OWN' ? 'Own account' : t === 'INTRA' ? 'VijayBank account' : 'Other bank'}
              </button>
            ))}
          </div>

          <label>
            From account
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.accountNo} value={a.accountNo}>
                  {a.type === 'SAVINGS' ? 'Savings' : 'Current'} {a.maskedAccountNo} · {rupees(a.balancePaise)}
                </option>
              ))}
            </select>
          </label>

          {tab === 'OWN' ? (
            <label>
              To account
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                <option value="">Select account</option>
                {accounts
                  .filter((a) => a.accountNo !== from)
                  .map((a) => (
                    <option key={a.accountNo} value={a.accountNo}>
                      {a.type === 'SAVINGS' ? 'Savings' : 'Current'} {a.maskedAccountNo}
                    </option>
                  ))}
              </select>
              {accounts.length < 2 && <small className="muted">You have only one account.</small>}
            </label>
          ) : (
            <label>
              Beneficiary
              <select value={beneficiaryId} onChange={(e) => setBeneficiaryId(e.target.value)} required>
                <option value="">Select beneficiary</option>
                {choices.map((b) => (
                  <option key={b.beneficiaryId} value={b.beneficiaryId} disabled={!b.canReceive}>
                    {b.name} · {b.bankName} {b.accountNoMasked}
                    {!b.canReceive && b.activatesAt ? ` (active from ${istDateTime(b.activatesAt)})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {tab === 'OTHER' && (
            <div className="segmented">
              {(['IMPS', 'NEFT', 'RTGS'] as const).map((n) => (
                <button type="button" key={n} className={network === n ? 'active' : ''} onClick={() => setNetwork(n)}>
                  <strong>{n}</strong>
                  <small>{n === 'IMPS' ? 'Instant · up to ₹5 lakh' : n === 'NEFT' ? '30-sec batches · up to ₹10 lakh' : '₹2 lakh and above'}</small>
                </button>
              ))}
            </div>
          )}

          <label>
            Amount (₹)
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="0.00" required />
          </label>
          <label>
            Remarks <span className="muted">(optional)</span>
            <input value={remarks} onChange={(e) => setRemarks(e.target.value.slice(0, 60))} />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn-primary" disabled={busy || !fromAccount}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          {limits && (
            <p className="hint">
              Daily limit {rupees(limits.dailyLimitPaise)} · used today {rupees(limits.usedTodayPaise)} · own-account transfers don't count
            </p>
          )}
        </form>

        <div className="stack">
          {result && <ResultCard t={result} />}
          <div className="card">
            <h3>Recent transfers</h3>
            {history.length === 0 ? (
              <p className="muted">No transfers yet.</p>
            ) : (
              <ul className="history">
                {history.map((t) => (
                  <li key={t.transferId}>
                    <div>
                      <strong>{t.beneficiaryName}</strong>
                      <small className="muted">
                        {MODE_LABEL[t.mode]} · {istDateTime(t.createdAt)} · {t.reference}
                      </small>
                    </div>
                    <div className="right">
                      <strong>{rupees(t.amountPaise)}</strong>
                      <span className={`status ${t.status.toLowerCase()}`}>{t.status.toLowerCase()}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {pending && (
        <OtpDialog
          title="Confirm transfer"
          summary={`${rupees(pending.amountPaise)} to ${pending.beneficiaryName} via ${MODE_LABEL[pending.mode]}`}
          onSubmit={confirm}
          onCancel={() => setPending(null)}
        />
      )}
    </Layout>
  );
}

function ResultCard({ t }: { t: Transfer }) {
  const text: Record<Transfer['status'], string> = {
    OTP_REQUIRED: 'Waiting for OTP',
    PROCESSING: t.mode === 'NEFT' ? 'Processing — NEFT settles in the next 30-second batch…' : 'Processing with the beneficiary bank…',
    COMPLETED: 'Transfer successful',
    FAILED: 'Transfer failed',
    BLOCKED: 'Transfer stopped',
  };
  return (
    <div className={`card result ${t.status.toLowerCase()}`}>
      <div className="result-head">
        <span className={`status ${t.status.toLowerCase()}`}>{t.status.toLowerCase()}</span>
        <strong>{text[t.status]}</strong>
      </div>
      <div className="result-amount">{rupees(t.amountPaise)}</div>
      <dl className="profile">
        <dt>To</dt>
        <dd>
          {t.beneficiaryName} {t.toAccountNoMasked}
        </dd>
        <dt>Mode</dt>
        <dd>{MODE_LABEL[t.mode]}</dd>
        <dt>Reference</dt>
        <dd>{t.reference}</dd>
        {t.failureReason && (
          <>
            <dt>Reason</dt>
            <dd>{REASON_LABEL[t.failureReason] ?? t.failureReason}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
