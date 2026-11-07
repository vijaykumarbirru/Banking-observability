import { useEffect, useState } from 'react';
import { ApiError, api, post, rupees } from '../api';
import Layout from '../components/Layout';
import OtpDialog from '../components/OtpDialog';
import { Card, Controls } from '../types';

type OtpTask = { title: string; summary: string; run: (otpRef: string, otp: string) => Promise<void>; otpRef: string };

export default function Cards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Controls | null>(null);
  const [otpTask, setOtpTask] = useState<OtpTask | null>(null);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = (keep?: string) =>
    api<Card[]>('/cards').then((c) => {
      setCards(c);
      const id = keep || selected || c[0]?.cardId || '';
      setSelected(id);
      setDraft(c.find((x) => x.cardId === id)?.controls ?? null);
    });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const card = cards.find((c) => c.cardId === selected);
  const select = (c: Card) => {
    setSelected(c.cardId);
    setDraft(c.controls);
    setMessage('');
    setError('');
  };

  /** Asks card-service to send an OTP, then opens the OTP dialog for the action. */
  async function withOtp(purpose: string, title: string, summary: string, run: OtpTask['run']) {
    const { otpRef } = await post<{ otpRef: string }>(`/cards/${card!.cardId}/otp`, { purpose });
    setOtpTask({ title, summary, run, otpRef });
  }

  async function block(reason: string) {
    setBlockReason(null);
    setError('');
    try {
      await post(`/cards/${card!.cardId}/block`, { reason });
      setMessage(reason === 'TEMPORARY' ? 'Card blocked. You can unblock it any time.' : 'Card permanently blocked. A replacement will be sent to you.');
      load(card!.cardId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not block the card.');
    }
  }

  async function unblock() {
    setError('');
    await withOtp('CARD_UNBLOCK', 'Unblock card', `${card!.variant} ${card!.maskedNumber}`, async (otpRef, otp) => {
      await post(`/cards/${card!.cardId}/unblock`, { otpRef, otp });
      setMessage('Card unblocked and ready to use.');
      load(card!.cardId);
    });
  }

  async function saveControls() {
    setError('');
    setMessage('');
    const put = (extra: object) => api(`/cards/${card!.cardId}/controls`, { method: 'PUT', body: JSON.stringify({ ...draft, ...extra }) });
    try {
      await put({});
      setMessage('Card controls updated.');
      load(card!.cardId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OTP_REQUIRED') {
        // Raising a limit or turning a feature on needs an OTP; lowering does not.
        await withOtp('CARD_CONTROLS', 'Confirm new card limits', 'Higher limits or new features need your OTP', async (otpRef, otp) => {
          await put({ otpRef, otp });
          setMessage('Card controls updated.');
          load(card!.cardId);
        });
      } else {
        setError(err instanceof Error ? err.message : 'Could not update controls.');
      }
    }
  }

  const limitRow = (label: string, field: 'atmLimitPaise' | 'posLimitPaise' | 'onlineLimitPaise') =>
    draft &&
    card && (
      <div className="limit-row" key={field}>
        <div className="limit-label">
          <span>{label}</span>
          <strong>{rupees(draft[field])}</strong>
        </div>
        <input
          type="range"
          min={0}
          max={card.caps[field]}
          step={500_00}
          value={draft[field]}
          onChange={(e) => setDraft({ ...draft, [field]: Number(e.target.value) })}
          disabled={card.status !== 'ACTIVE'}
        />
        <small className="muted">Max {rupees(card.caps[field])} per day</small>
      </div>
    );

  return (
    <Layout title="Cards" subtitle="Block a lost card instantly, set limits and control where your cards work">
      <section className="plastic-row">
        {cards.map((c) => (
          <button key={c.cardId} className={`plastic ${c.type.toLowerCase()} ${c.status.toLowerCase()} ${selected === c.cardId ? 'selected' : ''}`} onClick={() => select(c)}>
            <div className="plastic-top">
              <span>{c.variant}</span>
              <span className="network">{c.network}</span>
            </div>
            <span className="chip" />
            <div className="plastic-number">{c.maskedNumber}</div>
            <div className="plastic-bottom">
              <span>{c.holderName}</span>
              <span>
                <small>VALID THRU</small> {c.expiry}
              </span>
            </div>
            {c.status !== 'ACTIVE' && <span className="plastic-status">{c.status === 'BLOCKED' ? 'Temporarily blocked' : 'Permanently blocked'}</span>}
          </button>
        ))}
      </section>

      {message && <div className="notice">{message}</div>}
      {error && <div className="error">{error}</div>}

      {card && draft && (
        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h3>Usage limits &amp; controls</h3>
              <span className={`status ${card.status === 'ACTIVE' ? 'completed' : 'failed'}`}>{card.status.toLowerCase()}</span>
            </div>
            {limitRow('ATM withdrawals', 'atmLimitPaise')}
            {limitRow('Shops (POS)', 'posLimitPaise')}
            {limitRow('Online payments', 'onlineLimitPaise')}
            {(['internationalEnabled', 'contactlessEnabled'] as const).map((f) => (
              <label className="toggle-row" key={f}>
                <span>
                  <strong>{f === 'internationalEnabled' ? 'International usage' : 'Contactless (tap to pay)'}</strong>
                  <small className="muted">{f === 'internationalEnabled' ? 'Use the card abroad and on foreign websites' : 'Tap payments up to ₹5,000'}</small>
                </span>
                <input type="checkbox" className="switch" checked={draft[f]} disabled={card.status !== 'ACTIVE'} onChange={(e) => setDraft({ ...draft, [f]: e.target.checked })} />
              </label>
            ))}
            <div className="row-actions">
              <button className="btn-secondary" onClick={() => setDraft(card.controls)} disabled={card.status !== 'ACTIVE'}>
                Reset
              </button>
              <button className="btn-primary" onClick={saveControls} disabled={card.status !== 'ACTIVE'}>
                Save changes
              </button>
            </div>
          </div>

          <div className="stack">
            {card.type === 'CREDIT' && (
              <div className="card">
                <h3>Credit summary</h3>
                <dl className="profile">
                  <dt>Credit limit</dt>
                  <dd>{rupees(card.creditLimitPaise)}</dd>
                  <dt>Outstanding</dt>
                  <dd className="debit">{rupees(card.outstandingPaise)}</dd>
                  <dt>Available</dt>
                  <dd className="credit">{rupees(card.availableCreditPaise)}</dd>
                  <dt>Minimum due</dt>
                  <dd>{rupees(card.minimumDuePaise)}</dd>
                  <dt>Due date</dt>
                  <dd>{card.statementDueDate && new Date(card.statementDueDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</dd>
                </dl>
                <div className="meter">
                  <span style={{ width: `${Math.round(((card.outstandingPaise ?? 0) / (card.creditLimitPaise || 1)) * 100)}%` }} />
                </div>
              </div>
            )}
            <div className="card">
              <h3>Card security</h3>
              {card.status === 'ACTIVE' && (
                <>
                  <p className="muted small">Blocking is instant and needs no OTP.</p>
                  <div className="block-actions">
                    <button className="btn-secondary" onClick={() => setBlockReason('TEMPORARY')}>
                      Block temporarily
                    </button>
                    <button className="btn-danger" onClick={() => setBlockReason('LOST')}>
                      Report lost / stolen
                    </button>
                  </div>
                </>
              )}
              {card.status === 'BLOCKED' && (
                <>
                  <p className="muted small">This card is temporarily blocked. Unblocking needs an OTP.</p>
                  <button className="btn-primary" onClick={() => unblock().catch((e) => setError(e.message))}>
                    Unblock card
                  </button>
                </>
              )}
              {card.status === 'HOTLISTED' && <p className="muted">This card was reported {card.blockReason?.toLowerCase()} and is permanently blocked. A replacement card is on its way.</p>}
            </div>
          </div>
        </div>
      )}

      {blockReason && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>{blockReason === 'TEMPORARY' ? 'Block card temporarily?' : 'Report card lost or stolen?'}</h3>
            <p className="muted">
              {blockReason === 'TEMPORARY'
                ? 'All payments and withdrawals will be declined until you unblock the card.'
                : 'The card will be blocked permanently and cannot be unblocked. We will send you a replacement.'}
            </p>
            {blockReason !== 'TEMPORARY' && (
              <label>
                Reason
                <select value={blockReason} onChange={(e) => setBlockReason(e.target.value)}>
                  <option value="LOST">Lost</option>
                  <option value="STOLEN">Stolen</option>
                  <option value="DAMAGED">Damaged</option>
                </select>
              </label>
            )}
            <div className="row-actions">
              <button className="btn-secondary" onClick={() => setBlockReason(null)}>
                Cancel
              </button>
              <button className={blockReason === 'TEMPORARY' ? 'btn-primary' : 'btn-danger'} onClick={() => block(blockReason)}>
                Block card
              </button>
            </div>
          </div>
        </div>
      )}

      {otpTask && (
        <OtpDialog
          title={otpTask.title}
          summary={otpTask.summary}
          onSubmit={async (otp) => {
            await otpTask.run(otpTask.otpRef, otp);
            setOtpTask(null);
          }}
          onCancel={() => setOtpTask(null)}
        />
      )}
    </Layout>
  );
}
