import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, post, session } from '../api';
import Brand from './Brand';

type Customer = { fullName: string };

export default function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  useEffect(() => {
    api<Customer>('/customers/me')
      .then((c) => setName(c.fullName))
      .catch(() => undefined);
  }, []);

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
      <header className="topbar">
        <Brand light />
        <nav>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/transfers">Transfers</NavLink>
          <NavLink to="/beneficiaries">Beneficiaries</NavLink>
          <NavLink to="/statements">Statements</NavLink>
          <a className="disabled" title="Coming in Phase 3">
            Cards
          </a>
        </nav>
        <div className="user">
          <span>{name}</span>
          <button className="btn-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
      <footer className="footer">VijayBank is a fictional bank built for learning · All data is simulated</footer>
    </div>
  );
}
