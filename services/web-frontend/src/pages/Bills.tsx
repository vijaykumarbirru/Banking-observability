import { FormEvent, useEffect, useState } from 'react';
import { ApiError, api, istDateTime, post, rupees, toPaise } from '../api';
import Icon from '../components/Icon';
import Layout from '../components/Layout';
import OtpDialog from '../components/OtpDialog';
import { Account, BillPayment, Biller } from '../types';

const CATEGORIES = [
  { id: 'ELECTRICITY', label: 'Electricity', icon: 'growth' },
  { id: 'MOBILE', label: 'Mobile postpaid', icon: 'mobile' },
  { id: 'DTH', label: 'DTH', icon: 'home' },
  { id: 'GAS', label: 'Piped gas', icon: 'alert' },
  { id: 'BROADBAND', label: 'Broadband', icon: 'send' },
  { id: 'WATER', label: 'Water', icon: 'pin' },
];

type Bill = { billerName: string; consumerNumber: string; customerName: string; billNumber: string | null; dueAmountPaise: number | null; dueDate: string | null; recharge: boolean };

export default function Bills() {
  const [billers, setBillers] = useState<Biller[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [history, setHistory] = useState<BillPayment[]>([]);
  const [category, setCategory] = useState('ELECTRICITY');
  const [billerId, setBillerId] = useState('');
  const [consumer, setConsumer] = useState('');
  const [bill, setBill] = useState<Bill | null>(null);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [pending, setPending] = useState<BillPayment | null>(null);
  const [done, setDone] = useState<BillPayment | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const loadHistory = () => api<BillPayment[]>('/bill-payments').then(setHistory);
  useEffect(() => {
    api<Biller[]>('/billers').then(setBillers);
    api<Account[]>('/accounts').then((a) => {
      setAccounts(a);
      setFrom(a[0]?.accountNo ?? '');
    });
    loadHistory();
  }, []);

  const choices = billers.filter((b) => b.category === category);
  const biller = billers.find((b) => b.id === billerId);

  function pick(cat: string) {
    setCategory(cat);
    setBillerId('');
    setBill(null);
    setError('');
  }

  async function fetchBill(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBill(null);
    setDone(null);
    setBusy(true);
    try {
      const b = await post<Bill>('/bill-payments/fetch', { billerId, consumerNumber: consumer });
      setBill(b);
      setAmount(b.dueAmountPaise ? String(b.dueAmountPaise / 100) : '');
      setKey(crypto.randomUUID());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not fetch the bill.');
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setError('');
    setBusy(true);
    try {
      const p = await post<BillPayment>(
        '/bill-payments',
        { billerId, consumerNumber: bill!.consumerNumber, amountPaise: toPaise(amount), fromAccountNo: from },
        { 'Idempotency-Key': key },
      );
      if (p.status === 'OTP_REQUIRED') setPending(p);
      else setDone(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(otp: string) {
    try {
      const p = await post<BillPayment>(`/bill-payments/${pending!.paymentId}/confirm`, { otp });
      setPending(null);
      setDone(p);
      setBill(null);
      setConsumer('');
      loadHistory();
      api<Account[]>('/accounts').then(setAccounts);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_OTP') throw err;
      setPending(null);
      setError(err instanceof Error ? err.message : 'Payment failed.');
      loadHistory();
    }
  }

  return (
    <Layout title="Pay bills" subtitle="Electricity, mobile, DTH, gas, broadband and water — paid instantly">
      <section className="category-grid">
        {CATEGORIES.map((c) => (
          <button key={c.id} className={`category ${category === c.id ? 'active' : ''}`} onClick={() => pick(c.id)}>
            <span className="quick-icon">
              <Icon name={c.icon} />
            </span>
            {c.label}
          </button>
        ))}
      </section>

      <div className="grid-2">
        <div className="stack">
          <form className="card" onSubmit={fetchBill}>
            <h3>Find your bill</h3>
            <label>
              Biller
              <select value={billerId} onChange={(e) => { setBillerId(e.target.value); setBill(null); }} required>
                <option value="">Select biller</option>
                {choices.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {biller?.label ?? 'Consumer number'}
              <input value={consumer} onChange={(e) => setConsumer(e.target.value.toUpperCase())} required />
            </label>
            <button className="btn-primary" disabled={busy || !billerId}>
              {busy && !bill ? 'Fetching…' : biller?.recharge ? 'Continue' : 'Fetch bill'}
            </button>
          </form>

          {bill && (
            <div className="card bill-card">
              <div className="bill-head">
                <div>
                  <small className="muted">{bill.billerName}</small>
                  <h3>{bill.customerName}</h3>
                  <small className="muted">
                    {biller?.label} {bill.consumerNumber}
                    {bill.billNumber ? ` · Bill ${bill.billNumber}` : ''}
                  </small>
                </div>
                {bill.dueDate && <span className="status processing">Due {new Date(bill.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
              </div>
              {bill.dueAmountPaise === 0 ? (
                <div className="notice">No bill is due for this number right now.</div>
              ) : (
                <>
                  {bill.recharge ? (
                    <label>
                      Recharge amount (₹)
                      <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" />
                    </label>
                  ) : (
                    <div className="bill-amount">{rupees(bill.dueAmountPaise)}</div>
                  )}
                  <label>
                    Pay from
                    <select value={from} onChange={(e) => setFrom(e.target.value)}>
                      {accounts.map((a) => (
                        <option key={a.accountNo} value={a.accountNo}>
                          {a.type === 'SAVINGS' ? 'Savings' : 'Current'} {a.maskedAccountNo} · {rupees(a.balancePaise)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="btn-primary" onClick={pay} disabled={busy || !amount}>
                    Pay {amount ? rupees(toPaise(amount)) : ''}
                  </button>
                </>
              )}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {done && (
            <div className={`card result ${done.status.toLowerCase()}`}>
              <div className="result-head">
                <span className={`status ${done.status.toLowerCase()}`}>{done.status.toLowerCase()}</span>
                <strong>{done.status === 'COMPLETED' ? 'Bill paid successfully' : 'Payment not completed'}</strong>
              </div>
              <div className="result-amount">{rupees(done.amountPaise)}</div>
              <p className="muted">
                {done.billerName} · {done.consumerNumber} · Ref {done.reference}
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Recent bill payments</h3>
          {history.length === 0 ? (
            <p className="muted">No bills paid yet.</p>
          ) : (
            <ul className="history">
              {history.map((p) => (
                <li key={p.paymentId}>
                  <div>
                    <strong>{p.billerName}</strong>
                    <small className="muted">
                      {p.consumerNumber} · {istDateTime(p.createdAt)}
                    </small>
                  </div>
                  <div className="right">
                    <strong>{rupees(p.amountPaise)}</strong>
                    <span className={`status ${p.status.toLowerCase()}`}>{p.status.toLowerCase()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pending && (
        <OtpDialog
          title="Confirm bill payment"
          summary={`${rupees(pending.amountPaise)} to ${pending.billerName}`}
          onSubmit={confirm}
          onCancel={() => setPending(null)}
        />
      )}
    </Layout>
  );
}
