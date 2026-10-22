import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { Button, Text } from '../ui';
import { useSession } from './session';
import './shell.css';

const APP_NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/categories', label: 'Categories' },
];

/**
 * The one shell for desktop and mobile: app-level navigation in a sidebar
 * that becomes a drawer on small screens. Features add their in-app
 * sections with <InAppNav>. Pages render inside it unchanged.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const user = session.state.status === 'signedIn' ? session.state.user : null;

  return (
    <div className="shell" data-drawer={drawerOpen ? 'open' : 'closed'}>
      <header className="shell__topbar">
        <Button variant="ghost" aria-expanded={drawerOpen} aria-controls="app-navigation" onClick={() => setDrawerOpen((open) => !open)}>
          <span aria-hidden>☰</span>
          <span className="visually-hidden">Menu</span>
        </Button>
        <span className="shell__brand">Money</span>
      </header>
      <div className="shell__backdrop" onClick={() => setDrawerOpen(false)} aria-hidden />
      <aside className="shell__sidebar" id="app-navigation">
        <div>
          <NavLink to="/dashboard" className="shell__brand">
            Money
          </NavLink>
          <div className="shell__tagline">Personal investment tracking</div>
        </div>
        <nav className="shell__nav" aria-label="Main">
          {APP_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="shell__navlink">
              {item.label}
            </NavLink>
          ))}
        </nav>
        {user && (
          <div className="shell__user">
            <Text size="sm" tone="muted">
              Signed in as {user.displayName ?? user.email ?? 'you'}
            </Text>
            <Button size="sm" onClick={() => void session.signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </aside>
      <main className="shell__main" id="main">
        <div className="shell__content">
          {children}
        </div>
      </main>
    </div>
  );
}
