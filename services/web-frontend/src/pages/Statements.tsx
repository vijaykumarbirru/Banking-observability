import { FormEvent, useEffect, useState } from 'react';
import { api, download, isoDay, istDateTime, rupees } from '../api';
import Layout from '../components/Layout';
import { Account, Entry } from '../types';

type Summary = { openingBalancePaise: number; closingBalancePaise: number; totalCreditsPaise: number; totalDebitsPaise: number };
type Page = { total: number; page: number; size: number; summary: Summary; items: Entry[] };

const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

export default function Statements() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountNo, setAccountNo] = useState('');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(daysAgo(0));
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');

  useEffect(() => {
    api<Account[]>('/accounts').then((a) => {
      setAccounts(a);
      setAccountNo(a[0]?.accountNo ?? '');
    });
  }, []);

  const query = (p: number) => `from=${from}&to=${to}${type ? `&type=${type}` : ''}&page=${p}&size=15`;

  async function load(p = 1) {
    if (!accountNo) return;
    setError('');
    try {
      setData(await api<Page>(`/accounts/${accountNo}/transactions?${query(p)}`));
      setPage(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load transactions.');
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountNo]);

  async function get(format: 'pdf' | 'csv') {
    setDownloading(format);
    setError('');
    try {
      await download(`/accounts/${accountNo}/statement.${format}?from=${from}&to=${to}`, `statement.${format}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloading('');
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <Layout title="Account statement" subtitle="Search transactions and download PDF or CSV statements">
      <form
        className="card filters"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          load(1);
        }}
      >
        <label>
          Account
          <select value={accountNo} onChange={(e) => setAccountNo(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.accountNo} value={a.accountNo}>
                {a.type === 'SAVINGS' ? 'Savings' : 'Current'} {a.maskedAccountNo}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} min={from} max={daysAgo(0)} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            <option value="CREDIT">Credits</option>
            <option value="DEBIT">Debits</option>
          </select>
        </label>
        <button className="btn-primary">View</button>
      </form>

      {error && <div className="error">{error}</div>}

      {data && (
        <>
          <section className="summary">
            {[
              ['Opening balance', data.summary.openingBalancePaise],
              ['Credits', data.summary.totalCreditsPaise],
              ['Debits', data.summary.totalDebitsPaise],
              ['Closing balance', data.summary.closingBalancePaise],
            ].map(([label, v]) => (
              <div className="card stat" key={label as string}>
                <small className="muted">{label}</small>
                <strong>{rupees(v as number)}</strong>
              </div>
            ))}
          </section>

          <div className="card">
            <div className="card-head">
              <h3>
                {data.total} transaction{data.total === 1 ? '' : 's'}
              </h3>
              <div className="row-actions">
                <button className="btn-secondary" onClick={() => get('csv')} disabled={!!downloading}>
                  {downloading === 'csv' ? 'Preparing…' : 'Download CSV'}
                </button>
                <button className="btn-primary inline" onClick={() => get('pdf')} disabled={!!downloading}>
                  {downloading === 'pdf' ? 'Preparing…' : 'Download PDF'}
                </button>
              </div>
            </div>
            {data.items.length === 0 ? (
              <p className="muted">No transactions in this period.</p>
            ) : (
              <table className="txns">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id}>
                      <td className="muted nowrap">{istDateTime(e.postedAt)}</td>
                      <td>{e.narration}</td>
                      <td className="num debit">{e.direction === 'DEBIT' ? rupees(e.amountPaise) : ''}</td>
                      <td className="num credit">{e.direction === 'CREDIT' ? rupees(e.amountPaise) : ''}</td>
                      <td className="num">{rupees(e.balanceAfterPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="pager">
              <button className="btn-secondary" disabled={page <= 1} onClick={() => load(page - 1)}>
                Previous
              </button>
              <span className="muted">
                Page {page} of {pages}
              </span>
              <button className="btn-secondary" disabled={page >= pages} onClick={() => load(page + 1)}>
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
