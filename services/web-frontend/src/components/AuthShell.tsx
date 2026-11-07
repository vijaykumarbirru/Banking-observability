import { ReactNode, useEffect, useState } from 'react';
import Brand from './Brand';

// All offers are fictional and illustrative — VijayBank is a learning project.
const SLIDES = [
  {
    tag: 'Fixed Deposits',
    title: 'Grow your savings at up to 7.40% p.a.',
    text: 'Open a fixed deposit online in two minutes. Senior citizens earn an extra 0.50%.',
    cta: 'Open FD',
    theme: 'slide-saffron',
    icon: 'growth',
  },
  {
    tag: 'Credit Cards',
    title: '5% cashback on groceries and bills',
    text: 'The VijayBank Saffron card — lifetime free, contactless and accepted worldwide.',
    cta: 'Apply now',
    theme: 'slide-navy',
    icon: 'card',
  },
  {
    tag: 'Home Loans',
    title: 'Home loans from 8.35% p.a.',
    text: 'Zero processing fee this festive season. Instant in-principle approval.',
    cta: 'Check eligibility',
    theme: 'slide-plum',
    icon: 'home',
  },
  {
    tag: 'Payments',
    title: 'Free IMPS, NEFT and RTGS. Always.',
    text: 'Send money to any bank account in India — no transfer charges on net banking.',
    cta: 'Learn more',
    theme: 'slide-teal',
    icon: 'send',
  },
];

const OFFERS = [
  { icon: 'wallet', title: 'Zero-balance savings', text: 'No minimum balance, free debit card and 4% interest on savings.', badge: 'New' },
  { icon: 'gift', title: 'Festive dining offer', text: '20% off up to ₹750 at partner restaurants every weekend.', badge: 'Limited' },
  { icon: 'shield', title: 'Term insurance', text: '₹1 crore cover from ₹490 a month, issued instantly online.', badge: null },
  { icon: 'plane', title: 'Travel card', text: 'Load 15 currencies at zero markup and get free lounge access.', badge: 'Popular' },
];

const TIPS = [
  { icon: 'lock', title: 'Never share your OTP', text: 'VijayBank will never call, e-mail or message you asking for an OTP, password or PIN.' },
  { icon: 'eye', title: 'Check the address bar', text: 'Always type the web address yourself and look for the padlock before logging in.' },
  { icon: 'alert', title: 'Report fraud at once', text: 'Block your card from the app and call customer care if you see a transaction you did not make.' },
];

export function Icon({ name, size = 24 }: { name: string; size?: number }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<string, ReactNode> = {
    growth: <><path {...p} d="M3 17l6-6 4 4 8-8" /><path {...p} d="M15 7h6v6" /></>,
    card: <><rect {...p} x="2.5" y="5" width="19" height="14" rx="2.5" /><path {...p} d="M2.5 10h19M6.5 15h4" /></>,
    home: <><path {...p} d="M3 11l9-7 9 7" /><path {...p} d="M5 10v10h14V10M10 20v-6h4v6" /></>,
    send: <><path {...p} d="M21 3L10 14" /><path {...p} d="M21 3l-7 18-4-7-7-4 18-7z" /></>,
    wallet: <><path {...p} d="M3 7a2 2 0 012-2h13v4" /><rect {...p} x="3" y="7" width="18" height="13" rx="2" /><path {...p} d="M16 13.5h2" /></>,
    gift: <><rect {...p} x="3" y="8" width="18" height="4" rx="1" /><path {...p} d="M5 12v8h14v-8M12 8v12M12 8S10.5 4 8 4a2 2 0 000 4h4zM12 8s1.5-4 4-4a2 2 0 010 4h-4z" /></>,
    shield: <><path {...p} d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" /><path {...p} d="M9 12l2 2 4-4" /></>,
    plane: <path {...p} d="M10.5 13.5L3 11l1.5-1.5 7.5 1 4-4c1-1 3-1.5 3.5-1s0 2.5-1 3.5l-4 4 1 7.5L14 22l-2.5-7.5-3 3V20l-1.5 1-1-3-3-1 1-1.5h2.5l3-3z" />,
    lock: <><rect {...p} x="4" y="10" width="16" height="11" rx="2" /><path {...p} d="M8 10V7a4 4 0 018 0v3M12 14v3" /></>,
    eye: <><path {...p} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle {...p} cx="12" cy="12" r="3" /></>,
    alert: <><path {...p} d="M12 3l9.5 17h-19L12 3z" /><path {...p} d="M12 10v4M12 17.5v.01" /></>,
    phone: <path {...p} d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2z" />,
    pin: <><path {...p} d="M12 21s7-6.2 7-12a7 7 0 00-14 0c0 5.8 7 12 7 12z" /><circle {...p} cx="12" cy="9" r="2.5" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Carousel() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setI((n) => (n + 1) % SLIDES.length), 6000);
    return () => clearInterval(t);
  }, [paused]);
  const s = SLIDES[i];
  return (
    <section className={`promo ${s.theme}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      <div className="promo-body" key={i}>
        <span className="promo-tag">{s.tag}</span>
        <h1>{s.title}</h1>
        <p>{s.text}</p>
        <button type="button" className="promo-cta" title="Demo only">
          {s.cta} →
        </button>
      </div>
      <div className="promo-art" aria-hidden="true">
        <div className="promo-circle" />
        <div className="promo-icon">
          <Icon name={s.icon} size={64} />
        </div>
      </div>
      <div className="promo-dots">
        {SLIDES.map((sl, n) => (
          <button key={sl.tag} type="button" className={n === i ? 'active' : ''} onClick={() => setI(n)} aria-label={`Show ${sl.tag} offer`} />
        ))}
      </div>
    </section>
  );
}

/** Public landing layout shared by the login and OTP pages. */
export default function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="landing">
      <div className="utility-bar">
        <div className="wrap">
          <nav className="segments">
            <a className="active">Personal</a>
            <a>NRI</a>
            <a>Business</a>
            <a>Corporate</a>
          </nav>
          <div className="utility-links">
            <span>
              <Icon name="phone" size={14} /> 1800 000 0000 <small>(demo)</small>
            </span>
            <span>
              <Icon name="pin" size={14} /> Find a branch
            </span>
          </div>
        </div>
      </div>

      <header className="site-header">
        <div className="wrap">
          <Brand />
          <nav className="site-nav">
            <a>Accounts</a>
            <a>Cards</a>
            <a>Loans</a>
            <a>Investments</a>
            <a>Insurance</a>
            <a className="hot">Offers</a>
          </nav>
          <button type="button" className="btn-outline" title="Demo only">
            Open an account
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="wrap hero-grid">
          <Carousel />
          <div className="login-panel">{children}</div>
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>Offers for you</h2>
          <a className="see-all">View all offers →</a>
        </div>
        <div className="offer-grid">
          {OFFERS.map((o) => (
            <article className="offer" key={o.title}>
              <div className="offer-icon">
                <Icon name={o.icon} />
              </div>
              {o.badge && <span className="offer-badge">{o.badge}</span>}
              <h3>{o.title}</h3>
              <p>{o.text}</p>
              <a className="offer-link">Know more →</a>
            </article>
          ))}
        </div>
      </section>

      <section className="safety">
        <div className="wrap">
          <h2>Bank safely with VijayBank</h2>
          <div className="tip-grid">
            {TIPS.map((t) => (
              <div className="tip" key={t.title}>
                <div className="tip-icon">
                  <Icon name={t.icon} />
                </div>
                <div>
                  <h3>{t.title}</h3>
                  <p>{t.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="wrap footer-grid">
          <div>
            <Brand light />
            <p className="footer-about">Banking that keeps up with you — accounts, payments, cards and loans in one place.</p>
          </div>
          {[
            ['Accounts', ['Savings account', 'Current account', 'Fixed deposits', 'Recurring deposits']],
            ['Cards & Loans', ['Credit cards', 'Debit cards', 'Home loans', 'Personal loans']],
            ['Help', ['Customer care', 'Report fraud', 'Interest rates', 'Service charges']],
          ].map(([title, links]) => (
            <div key={title as string}>
              <h4>{title as string}</h4>
              {(links as string[]).map((l) => (
                <a key={l}>{l}</a>
              ))}
            </div>
          ))}
        </div>
        <div className="wrap footer-legal">
          VijayBank is a fictional bank created for a software learning project. It is not a real financial institution; all offers,
          rates, phone numbers and data on this site are illustrative and simulated.
        </div>
      </footer>
    </div>
  );
}
