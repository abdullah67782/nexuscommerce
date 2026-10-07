'use client';
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useRouter } from 'next/navigation';
import Sidebar from './Sidebar';
import Navbar from './Navbar';
import { BrandMark } from './Brand';

// Client-side guard and the workspace shell (rail + strip + content).
export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const shellRef = useRef(null);

  useEffect(() => { if (!loading && !user) router.push('/login'); }, [user, loading, router]);

  // Mobile drawer: focus trap + Escape to close.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const previous = document.activeElement;
    const nav = shellRef.current?.querySelector('aside');
    nav?.querySelector('a')?.focus();
    const key = e => {
      if (e.key === 'Escape') { setSidebarOpen(false); previous?.focus(); }
      if (e.key === 'Tab' && window.innerWidth < 1024) {
        const items = nav?.querySelectorAll('a,button');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [sidebarOpen]);

  if (loading) {
    return (
      <div className="empty-screen" role="status">
        <BrandMark />
        <p className="text-label">Opening your workspace…</p>
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="shell" ref={shellRef}>
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="shell-body">
        <Navbar onToggleSidebar={() => setSidebarOpen(s => !s)} sidebarOpen={sidebarOpen} />
        <main id="main-content" className="shell-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
