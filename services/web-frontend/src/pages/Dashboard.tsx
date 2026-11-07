import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, istDateTime, rupees, session } from '../api';
import Layout from '../components/Layout';

type Customer = { customerId: string; fullName: string; email: string; mobile: string; city: string; kycStatus: string };
type Account = {
  accountNo: string;
  maskedAccountNo: string;
  type: string;
  nickname: string | null;
  branch: string;
  ifsc: string;
  balancePaise: number | null;
};
type Entry = { id: number; direction: 'DEBIT' | 'CREDIT'; amountPaise: number; balanceAfterPaise: number; narration: string; postedAt: string };

export default function Dashboard() {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');

  const expired = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      session.clear();
      navigate('/login', { replace: true });
      return true;
    }
    return false;
  };

  useEffect(() => {
    Promise.all([api<Customer>('/customers/me'), api<Account[]>('/accounts')])
      .then(([c, a]) => {
        setCustomer(c);
        setAccounts(a);
        setSelected(a[0]?.accountNo ?? null);
      })
      .catch((err) => !expired(err) && setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    api<Entry[]>(`/accounts/${selected}/transactions/recent?limit=5`)
      .then(setEntries)
      .catch((err) => !expired(err) && setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const total = accounts.reduce((sum, a) => sum + (a.balancePaise ?? 0), 0);
  const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <Layout>
        {error && <div className="error">{error}</div>}
        <section className="welcome">
          <div>
            <h1>
              {greeting}
              {customer ? `, ${customer.fullName.split(' ')[0]}` : ''}
            </h1>
            <p className="muted">
              Customer ID {customer?.customerId} · KYC {customer?.kycStatus?.toLowerCase()}
            </p>
          </div>
          <div className="total">
            <small>Total balance</small>
            <strong>{rupees(total)}</strong>
          </div>
        </section>

        <section className="accounts">
          {accounts.map((a) => (
            <button key={a.accountNo} className={`card account ${selected === a.accountNo ? 'selected' : ''}`} onClick={() => setSelected(a.accountNo)}>
              <div className="account-top">
                <span className={`pill ${a.type.toLowerCase()}`}>{a.type === 'SAVINGS' ? 'Savings' : 'Current'}</span>
                <span className="muted">{a.maskedAccountNo}</span>
              </div>
              <div className="balance">{rupees(a.balancePaise)}</div>
              <div className="muted small">
                {a.branch} · {a.ifsc}
              </div>
            </button>
          ))}
        </section>

        <section className="grid-2">
          <div className="card">
            <h3>Recent transactions</h3>
            {entries.length === 0 ? (
              <p className="muted">No transactions yet.</p>
            ) : (
              <table className="txns">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="num">Amount</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="muted nowrap">{istDateTime(e.postedAt)}</td>
                      <td>{e.narration}</td>
                      <td className={`num ${e.direction === 'CREDIT' ? 'credit' : 'debit'}`}>
                        {e.direction === 'CREDIT' ? '+' : '−'}
                        {rupees(e.amountPaise)}
                      </td>
                      <td className="num">{rupees(e.balanceAfterPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h3>Profile</h3>
            <dl className="profile">
              <dt>Name</dt>
              <dd>{customer?.fullName}</dd>
              <dt>Mobile</dt>
              <dd>{customer?.mobile}</dd>
              <dt>E-mail</dt>
              <dd>{customer?.email}</dd>
              <dt>City</dt>
              <dd>{customer?.city}</dd>
            </dl>
          </div>
        </section>
    </Layout>
  );
}
