import { ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, istDateTime, post, session } from '../api';
import Brand from './Brand';
import Icon from './Icon';

type Customer = { customerId: string; fullName: string; mobile: string; email: string; city: string };
type Notification = { eventType: string; message: string; createdAt: string };

const SEEN_KEY = 'vijaybank.notificationsSeenAt';
const readSeen = () => {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0);
  } catch {
    return 0;
  }
};

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: 'grid' },
  { to: '/transfers', label: 'Transfers', icon: 'transfer' },
  { to: '/beneficiaries', label: 'Beneficiaries', icon: 'users' },
  { to: '/statements', label: 'Statements', icon: 'file' },
];

/** Closes a dropdown when clicking anywhere outside it. */
function useOutsideClick(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

function initials(name?: string) {
  return (name ?? '')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function Layout({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [alerts, setAlerts] = useState<Notification[]>([]);
  const [seenAt, setSeenAt] = useState(readSeen);
  const [open, setOpen] = useState<'bell' | 'user' | null>(null);
  const bellRef = useOutsideClick(() => setOpen((o) => (o === 'bell' ? null : o)));
  const userRef = useOutsideClick(() => setOpen((o) => (o === 'user' ? null : o)));

  useEffect(() => {
    api<Customer>('/customers/me').then(setCustomer).catch(() => undefined);
    const load = () => api<Notification[]>('/notifications').then(setAlerts).catch(() => undefined);
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const unread = alerts.filter((a) => new Date(a.createdAt).getTime() > seenAt).length;

  function toggleBell() {
    setOpen(open === 'bell' ? null : 'bell');
    if (open !== 'bell') {
      const now = Date.now();
      setSeenAt(now);
      try {
        localStorage.setItem(SEEN_KEY, String(now));
      } catch {
        /* storage may be unavailable */
      }
    }
  }

  async function logout() {
    try {
      await post('/auth/logout', { refreshToken: session.get()?.refreshToken });
    } catch {
      /* logging out locally is what matters */
    }
    session.clear();
    navigate('/login?reason=logout', { replace: true });
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="wrap app-header-row">
          <Brand light />
          <nav className="app-nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to}>
                <Icon name={n.icon} size={18} />
                <span>{n.label}</span>
              </NavLink>
            ))}
            <a className="disabled" title="Coming in Phase 3">
              <Icon name="card" size={18} />
              <span>Cards</span>
            </a>
          </nav>

          <div className="header-tools">
            <div className="dropdown" ref={bellRef}>
              <button className="icon-btn" onClick={toggleBell} aria-label="Notifications">
                <Icon name="bell" size={20} />
                {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
              </button>
              {open === 'bell' && (
                <div className="menu menu-wide">
                  <div className="menu-head">Alerts</div>
                  {alerts.length === 0 ? (
                    <p className="muted menu-empty">No alerts yet.</p>
                  ) : (
                    alerts.slice(0, 6).map((a) => (
                      <div className="alert-item" key={a.createdAt + a.eventType}>
                        <p>{a.message.replace(/^VijayBank: /, '')}</p>
                        <time>{istDateTime(a.createdAt)}</time>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="dropdown" ref={userRef}>
              <button className="user-btn" onClick={() => setOpen(open === 'user' ? null : 'user')}>
                <span className="avatar">{initials(customer?.fullName)}</span>
                <span className="user-name">{customer?.fullName?.split(' ')[0]}</span>
                <Icon name="chevron" size={16} />
              </button>
              {open === 'user' && (
                <div className="menu">
                  <div className="menu-profile">
                    <span className="avatar lg">{initials(customer?.fullName)}</span>
                    <div>
                      <strong>{customer?.fullName}</strong>
                      <small className="muted">Customer ID {customer?.customerId}</small>
                    </div>
                  </div>
                  <dl className="menu-details">
                    <dt>Mobile</dt>
                    <dd>{customer?.mobile}</dd>
                    <dt>E-mail</dt>
                    <dd>{customer?.email}</dd>
                    <dt>City</dt>
                    <dd>{customer?.city}</dd>
                  </dl>
                  <button className="menu-item danger" onClick={logout}>
                    <Icon name="logout" size={18} /> Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {title && (
        <section className="page-head">
          <div className="wrap page-head-row">
            <div>
              <div className="crumbs">
                <NavLink to="/dashboard">Home</NavLink> <span>/</span> {title}
              </div>
              <h1>{title}</h1>
              {subtitle && <p className="muted">{subtitle}</p>}
            </div>
            {actions && <div className="page-actions">{actions}</div>}
          </div>
        </section>
      )}

      <main className="wrap app-main">{children}</main>

      <footer className="app-footer">
        <div className="wrap app-footer-row">
          <span>© VijayBank · a fictional bank built for learning · all data is simulated</span>
          <span className="secure">
            <Icon name="lock" size={14} /> Secure session · auto logout after 5 minutes idle
          </span>
        </div>
      </footer>
    </div>
  );
}
