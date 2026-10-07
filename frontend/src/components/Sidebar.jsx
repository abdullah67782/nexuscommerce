'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlineSquares2X2, HiOutlineCircleStack, HiOutlinePresentationChartLine, HiOutlineCube, HiOutlineTag,
  HiOutlineArrowRightOnRectangle, HiOutlineXMark,
} from 'react-icons/hi2';
import Brand from './Brand';

// Adding a protected page = ProtectedRoute wrapper + middleware.js matcher + an entry here.
export const NAV = [
  { label: 'Overview', href: '/dashboard', icon: HiOutlineSquares2X2 },
  { label: 'Data Integration', href: '/upload', icon: HiOutlineCircleStack },
  { label: 'Demand Forecasting', href: '/forecasting', icon: HiOutlinePresentationChartLine },
  { label: 'Inventory', href: '/inventory', icon: HiOutlineCube },
  { label: 'Pricing', href: '/pricing', icon: HiOutlineTag },
];

export const isActivePath = (pathname, href) => pathname === href || pathname.startsWith(href + '/');

export default function Sidebar({ open, onClose }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const name = user?.name || user?.email || 'Account';
  return (
    <>
      {open && <button className="sidebar-overlay" onClick={onClose} aria-label="Close navigation" tabIndex={-1} />}
      <aside id="workspace-navigation" className={`sidebar ${open ? 'is-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand href="/dashboard" />
          <button onClick={onClose} className="icon-button sidebar-close" aria-label="Close navigation"><HiOutlineXMark /></button>
        </div>

        <nav aria-label="Workspace" className="sidebar-nav">
          <ul>
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = isActivePath(pathname, href);
              return (
                <li key={href}>
                  <Link href={href} onClick={onClose} className={`sidebar-link ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="sidebar-foot">
          <span className="avatar" aria-hidden="true">{name[0].toUpperCase()}</span>
          <div className="sidebar-user">
            <p>{name}</p>
            <span>{user?.role || 'seller'}</span>
          </div>
          <button onClick={logout} className="icon-button" aria-label="Sign out" title="Sign out"><HiOutlineArrowRightOnRectangle /></button>
        </div>
      </aside>
    </>
  );
}
