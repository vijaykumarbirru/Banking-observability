import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, isoDay, istDateTime, rupees, session } from '../api';
import Icon from '../components/Icon';
import Layout from '../components/Layout';
import { Account, Entry } from '../types';

type Customer = { customerId: string; fullName: string; kycStatus: string };
type Month = { summary: { totalCreditsPaise: number; totalDebitsPaise: number } };
type Alert = { eventType: string; message: string; createdAt: string };

const HIDE_KEY = 'vijaybank.hideBalances';

/** Picks an icon and a readable category from a ledger narration. */
function category(narration: string): { icon: string; label: string } {
  const n = narration.toUpperCase();
  if (n.startsWith('SALARY')) return { icon: 'briefcase', label: 'Salary' };
  if (n.startsWith('UPI')) return { icon: 'mobile', label: 'UPI' };
  if (n.startsWith('POS')) return { icon: 'bag', label: 'Card purchase' };
  if (n.startsWith('ATM')) return { icon: 'cash', label: 'ATM withdrawal' };
  if (n.startsWith('BILLPAY')) return { icon: 'bill', label: 'Bill payment' };
  if (n.startsWith('REV')) return { icon: 'refresh', label: 'Reversal' };
  if (n.startsWith('OPENING')) return { icon: 'bank', label: 'Account opening' };
  return { icon: 'transfer', label: 'Transfer' };
}

function readHidden() {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [month, setMonth] = useState<Month['summary'] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [hidden, setHidden] = useState(readHidden);
  const [error, setError] = useState('');

  const handle = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      session.clear();
      navigate('/login', { replace: true });
    } else {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  useEffect(() => {
    Promise.all([api<Customer>('/customers/me'), api<Account[]>('/accounts')])
      .then(([c, a]) => {
        setCustomer(c);
        setAccounts(a);
        setSelected(a[0]?.accountNo ?? null);
      })
      .catch(handle);
    api<Alert[]>('/notifications')
      .then((n) => setAlerts(n.slice(0, 4)))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    const today = new Date();
    const monthStart = isoDay(new Date(today.getFullYear(), today.getMonth(), 1, 12));
    api<Entry[]>(`/accounts/${selected}/transactions/recent?limit=6`).then(setEntries).catch(handle);
    api<Month>(`/accounts/${selected}/transactions?from=${monthStart}&to=${isoDay(today)}&size=1`)
      .then((m) => setMonth(m.summary))
      .catch(() => setMonth(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function toggleHidden() {
    setHidden(!hidden);
    try {
      localStorage.setItem(HIDE_KEY, hidden ? '0' : '1');
    } catch {
      /* storage may be unavailable */
    }
  }

  const money = (paise: number | null | undefined) => (hidden ? '₹ ••••••' : rupees(paise));
  const total = accounts.reduce((sum, a) => sum + (a.balancePaise ?? 0), 0);
  const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const sel = accounts.find((a) => a.accountNo === selected);
  const spentPct = month && month.totalCreditsPaise > 0 ? Math.min(100, Math.round((month.totalDebitsPaise / month.totalCreditsPaise) * 100)) : 0;

  const actions = [
    { label: 'Transfer money', icon: 'send', to: '/transfers' },
    { label: 'Add beneficiary', icon: 'users', to: '/beneficiaries' },
    { label: 'Statements', icon: 'download', to: '/statements' },
    { label: 'Pay bills', icon: 'bill', soon: true },
    { label: 'Cards', icon: 'card', soon: true },
    { label: 'Open FD', icon: 'fd', soon: true },
  ];

  return (
    <Layout>
      {error && <div className="error">{error}</div>}

      <section className="welcome-banner">
        <div>
          <p className="welcome-kicker">{greeting},</p>
          <h1>{customer?.fullName ?? ' '}</h1>
          <p className="welcome-meta">
            Customer ID {customer?.customerId} · KYC {customer?.kycStatus?.toLowerCase()} · {istDateTime(new Date().toISOString())}
          </p>
        </div>
        <div className="welcome-total">
          <span>
            Total balance
            <button className="eye-btn" onClick={toggleHidden} aria-label={hidden ? 'Show balances' : 'Hide balances'}>
              <Icon name={hidden ? 'eye' : 'eyeOff'} size={16} />
            </button>
          </span>
          <strong>{money(total)}</strong>
          <small>
            across {accounts.length} account{accounts.length === 1 ? '' : 's'}
          </small>
        </div>
      </section>

      <section className="quick-actions">
        {actions.map((a) =>
          a.soon ? (
            <div className="quick soon" key={a.label} title="Coming in Phase 3">
              <span className="quick-icon">
                <Icon name={a.icon} />
              </span>
              {a.label}
              <small>Soon</small>
            </div>
          ) : (
            <Link className="quick" to={a.to!} key={a.label}>
              <span className="quick-icon">
                <Icon name={a.icon} />
              </span>
              {a.label}
            </Link>
          ),
        )}
      </section>

      <section className="bank-cards">
        {accounts.map((a) => (
          <button key={a.accountNo} className={`bank-card ${a.type.toLowerCase()} ${selected === a.accountNo ? 'selected' : ''}`} onClick={() => setSelected(a.accountNo)}>
            <div className="bank-card-top">
              <span>{a.type === 'SAVINGS' ? 'Savings Account' : 'Current Account'}</span>
              <span className="chip" />
            </div>
            <div className="bank-card-balance">
              <small>Available balance</small>
              <strong>{money(a.balancePaise)}</strong>
            </div>
            <div className="bank-card-bottom">
              <span className="acct-no">{a.accountNo.replace(/(\d{4})(?=\d)/g, '$1 ')}</span>
              <span>{a.ifsc}</span>
            </div>
          </button>
        ))}
      </section>

      <section className="dash-grid">
        <div className="card">
          <div className="card-head">
            <div>
              <h3>Recent transactions</h3>
              <small className="muted">
                {sel ? `${sel.type === 'SAVINGS' ? 'Savings' : 'Current'} ${sel.maskedAccountNo}` : ''}
              </small>
            </div>
            <Link to="/statements" className="text-link">
              View statement →
            </Link>
          </div>
          {entries.length === 0 ? (
            <p className="muted">No transactions yet.</p>
          ) : (
            <ul className="txn-list">
              {entries.map((e) => {
                const c = category(e.narration);
                return (
                  <li key={e.id}>
                    <span className={`txn-icon ${e.direction === 'CREDIT' ? 'in' : 'out'}`}>
                      <Icon name={c.icon} size={20} />
                    </span>
                    <div className="txn-main">
                      <strong>{e.narration}</strong>
                      <small className="muted">
                        {c.label} · {istDateTime(e.postedAt)}
                      </small>
                    </div>
                    <div className="txn-amount">
                      <strong className={e.direction === 'CREDIT' ? 'credit' : 'debit'}>
                        {e.direction === 'CREDIT' ? '+' : '−'}
                        {hidden ? '••••' : rupees(e.amountPaise)}
                      </strong>
                      <small className="muted">Bal {money(e.balanceAfterPaise)}</small>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="side-stack">
          <div className="card">
            <h3>This month</h3>
            {month ? (
              <>
                <div className="month-row">
                  <span className="month-label">
                    <span className="dot in" /> Money in
                  </span>
                  <strong className="credit">{money(month.totalCreditsPaise)}</strong>
                </div>
                <div className="month-row">
                  <span className="month-label">
                    <span className="dot out" /> Money out
                  </span>
                  <strong className="debit">{money(month.totalDebitsPaise)}</strong>
                </div>
                <div className="meter" role="img" aria-label={`Spent ${spentPct}% of money received`}>
                  <span style={{ width: `${spentPct}%` }} />
                </div>
                <small className="muted">
                  {month.totalDebitsPaise > month.totalCreditsPaise
                    ? `You spent ${rupees(month.totalDebitsPaise - month.totalCreditsPaise)} more than came in this month.`
                    : `You have spent ${spentPct}% of what came in this month.`}
                </small>
              </>
            ) : (
              <p className="muted">No data yet.</p>
            )}
          </div>

          <div className="offer-card">
            <span className="promo-tag">Pre-approved</span>
            <h3>Personal loan up to ₹5,00,000</h3>
            <p>Money in your account in 10 seconds. No paperwork.</p>
            <button type="button" title="Demo only">
              Check offer →
            </button>
            <small>Illustrative offer · VijayBank is fictional</small>
          </div>

          <div className="card">
            <h3>Recent alerts</h3>
            {alerts.length === 0 ? (
              <p className="muted">No alerts yet.</p>
            ) : (
              alerts.map((a) => (
                <div className="alert-item" key={a.createdAt + a.eventType}>
                  <p>{a.message.replace(/^VijayBank: /, '')}</p>
                  <time>{istDateTime(a.createdAt)}</time>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </Layout>
  );
}
