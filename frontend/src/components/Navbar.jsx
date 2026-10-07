'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import { HiOutlineBars3, HiOutlineBell, HiOutlineChevronDown, HiOutlineArrowRightOnRectangle } from 'react-icons/hi2';
import { NAV, isActivePath } from './Sidebar';

// Sample activity only — there is no notifications API yet.
const NOTIFICATIONS = [
  { title: 'Low stock alert', time: '2 min ago', desc: 'Wireless Mouse below threshold', tone: 'var(--warning)' },
  { title: 'Forecast complete', time: '15 min ago', desc: '30-day forecast generated', tone: 'var(--forecast)' },
  { title: 'Training complete', time: '1 hr ago', desc: 'Your model updated successfully', tone: 'var(--success)' },
];

function Clock() {
  // The shell renders client-side only (behind ProtectedRoute), so reading the
  // clock in the initialiser can't cause a hydration mismatch.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className="topbar-clock" dateTime={now.toISOString()}>
      {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
}

export default function Navbar({ onToggleSidebar, sidebarOpen }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);
  const current = NAV.find(n => isActivePath(pathname, n.href));

  useEffect(() => {
    const outside = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null); };
    const escape = e => {
      if (e.key === 'Escape') { setMenu(null); menuRef.current?.querySelector('[aria-expanded="true"]')?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button topbar-menu" onClick={onToggleSidebar} aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'} aria-controls="workspace-navigation" aria-expanded={sidebarOpen}><HiOutlineBars3 /></button>
        <p className="topbar-crumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{current?.label || 'NexusCommerce'}</strong></p>
      </div>

      <div className="topbar-right" ref={menuRef}>
        <Clock />
        <div className="topbar-anchor">
          <button className="icon-button" aria-label="Notifications" aria-expanded={menu === 'notifications'} aria-controls="notifications-panel" onClick={() => setMenu(menu === 'notifications' ? null : 'notifications')}>
            <HiOutlineBell /><span className="topbar-ping" aria-hidden="true" />
          </button>
          {menu === 'notifications' && (
            <section id="notifications-panel" className="popover" aria-label="Notifications">
              <div className="popover-head"><h2 className="text-panel">Notifications</h2><span className="status status-neutral">Sample activity</span></div>
              <ul className="row-list">
                {NOTIFICATIONS.map(n => (
                  <li key={n.title} className="list-row">
                    <span className="dot" style={{ '--tone': n.tone }} />
                    <div className="list-row-main">
                      <p className="list-row-title">{n.title}</p>
                      <p className="list-row-meta">{n.desc}</p>
                    </div>
                    <span className="text-label">{n.time}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        {user && (
          <div className="topbar-anchor">
            <button className="topbar-account" onClick={() => setMenu(menu === 'account' ? null : 'account')} aria-label="Account menu" aria-expanded={menu === 'account'} aria-controls="account-panel">
              <span className="avatar">{(user.name || user.email || '?')[0].toUpperCase()}</span>
              <span className="topbar-account-name">{user.name?.split(' ')[0] || user.email}</span>
              <HiOutlineChevronDown />
            </button>
            {menu === 'account' && (
              <section id="account-panel" className="popover popover-narrow" aria-label="Account">
                <div className="account-card">
                  <p className="list-row-title">{user.name}</p>
                  <p className="list-row-meta">{user.email}</p>
                  <span className="status status-accent is-cap">{user.role}</span>
                </div>
                <button onClick={() => { setMenu(null); logout(); }} className="account-signout"><HiOutlineArrowRightOnRectangle />Sign out</button>
              </section>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
