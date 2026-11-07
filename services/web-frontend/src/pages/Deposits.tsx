import { FormEvent, useEffect, useState } from 'react';
import { api, post, rupees, toPaise } from '../api';
import Layout from '../components/Layout';
import { Account, Deposit } from '../types';

type Rate = { tenureMonths: number; rateBps: number };

/** Same quarterly-compounding formula as account-service, for the live preview. */
const maturity = (paise: number, rateBps: number, months: number) => Math.round(paise * Math.pow(1 + rateBps / 40000, months / 3));
const tenureLabel = (m: number) => (m % 12 === 0 ? `${m / 12} year${m > 12 ? 's' : ''}` : `${m} months`);
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' });

export default function Deposits() {
  const [rates, setRates] = useState<Rate[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [from, setFrom] = useState('');
  const [amount, setAmount] = useState('50000');
  const [tenure, setTenure] = useState(12);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const load = () => {
    api<Deposit[]>('/deposits').then(setDeposits);
    api<Account[]>('/accounts').then((a) => {
      setAccounts(a);
      setFrom((f) => f || a[0]?.accountNo || '');
    });
  };
  useEffect(() => {
    api<Rate[]>('/deposits/rates').then(setRates);
    load();
  }, []);

  const rate = rates.find((r) => r.tenureMonths === tenure)?.rateBps ?? 0;
  const paise = toPaise(amount || '0');
  const preview = paise > 0 && rate ? maturity(paise, rate, tenure) : 0;
  const best = Math.max(...rates.map((r) => r.rateBps), 0);

  async function open(e: FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!window.confirm(`Book a fixed deposit of ${rupees(paise)} for ${tenureLabel(tenure)} at ${(rate / 100).toFixed(2)}%?`)) return;
    setBusy(true);
    try {
      const d = await post<Deposit>('/deposits', { fundingAccountNo: from, amountPaise: paise, tenureMonths: tenure }, { 'Idempotency-Key': key });
      setNotice(`Fixed deposit ${d.fdNo} booked. It matures on ${fmtDate(d.maturityDate)} with ${rupees(d.maturityAmountPaise)}.`);
      setKey(crypto.randomUUID());
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the deposit.');
    } finally {
      setBusy(false);
    }
  }

  async function close(d: Deposit) {
    if (!window.confirm(`Close ${d.fdNo} before maturity? Interest is paid at 1% below the booked rate, and nothing in the first 7 days.`)) return;
    setError('');
    try {
      const c = await post<Deposit>(`/deposits/${d.depositId}/close`, {});
      setNotice(`${c.fdNo} closed. ${rupees(c.payoutPaise)} credited to your account.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the deposit.');
    }
  }

  return (
    <Layout title="Fixed deposits" subtitle={`Earn up to ${(best / 100).toFixed(2)}% p.a. with guaranteed returns`}>
      <section className="rate-strip">
        {rates.map((r) => (
          <button key={r.tenureMonths} className={`rate ${tenure === r.tenureMonths ? 'active' : ''}`} onClick={() => setTenure(r.tenureMonths)}>
            {r.rateBps === best && <span className="offer-badge">Best rate</span>}
            <small>{tenureLabel(r.tenureMonths)}</small>
            <strong>{(r.rateBps / 100).toFixed(2)}%</strong>
          </button>
        ))}
      </section>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="grid-2">
        <div className="card">
          <h3>Your deposits</h3>
          {deposits.length === 0 ? (
            <p className="muted">You have no fixed deposits yet.</p>
          ) : (
            <ul className="fd-list">
              {deposits.map((d) => {
                const total = new Date(d.maturityDate).getTime() - new Date(d.startDate).getTime();
                const elapsed = Math.min(1, Math.max(0, (Date.now() - new Date(d.startDate).getTime()) / total));
                return (
                  <li key={d.depositId} className={d.status === 'CLOSED' ? 'closed' : ''}>
                    <div className="fd-head">
                      <div>
                        <strong>{rupees(d.principalPaise)}</strong>
                        <small className="muted">
                          {d.fdNo} · {(d.rateBps / 100).toFixed(2)}% · {tenureLabel(d.tenureMonths)}
                        </small>
                      </div>
                      <span className={`status ${d.status === 'ACTIVE' ? 'completed' : 'otp_required'}`}>{d.status.toLowerCase()}</span>
                    </div>
                    {d.status === 'CLOSED' ? (
                      <p className="muted small">
                        Closed on {d.closedOn && fmtDate(d.closedOn)} · paid out {rupees(d.payoutPaise)}
                      </p>
                    ) : (
                      <>
                        <div className="meter">
                          <span style={{ width: `${Math.round(elapsed * 100)}%` }} />
                        </div>
                        <div className="fd-foot">
                          <small className="muted">
                            {fmtDate(d.startDate)} → {fmtDate(d.maturityDate)}
                          </small>
                          <small>
                            Maturity <strong>{rupees(d.maturityAmountPaise)}</strong>
                          </small>
                        </div>
                        <button className="btn-link small-btn" onClick={() => close(d)}>
                          Close early
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <form className="card" onSubmit={open}>
          <h3>Open a fixed deposit</h3>
          <label>
            Debit from
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.accountNo} value={a.accountNo}>
                  {a.type === 'SAVINGS' ? 'Savings' : 'Current'} {a.maskedAccountNo} · {rupees(a.balancePaise)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount (₹)
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" required />
          </label>
          <label>
            Tenure
            <select value={tenure} onChange={(e) => setTenure(Number(e.target.value))}>
              {rates.map((r) => (
                <option key={r.tenureMonths} value={r.tenureMonths}>
                  {tenureLabel(r.tenureMonths)} · {(r.rateBps / 100).toFixed(2)}% p.a.
                </option>
              ))}
            </select>
          </label>
          <div className="fd-preview">
            <div>
              <small className="muted">You invest</small>
              <strong>{rupees(paise)}</strong>
            </div>
            <div>
              <small className="muted">Interest earned</small>
              <strong className="credit">{rupees(Math.max(0, preview - paise))}</strong>
            </div>
            <div>
              <small className="muted">Maturity value</small>
              <strong>{rupees(preview)}</strong>
            </div>
          </div>
          <button className="btn-primary" disabled={busy || paise < 10_000_00}>
            {busy ? 'Booking…' : 'Book fixed deposit'}
          </button>
          <p className="hint">Minimum ₹10,000 · interest compounded quarterly · rates are illustrative</p>
        </form>
      </div>
    </Layout>
  );
}
