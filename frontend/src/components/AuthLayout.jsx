'use client';
import Link from 'next/link';
import { HiArrowLeft } from 'react-icons/hi2';
import Brand from './Brand';
import NexusFallback from './nexus/NexusFallback';

export default function AuthLayout({ children, signup = false }) {
  return (
    <div className="auth">
      <aside className="auth-stage" aria-label="About NexusCommerce">
        <div className="nexus-stage" aria-hidden="true"><div className="nexus-fallback-layer"><NexusFallback variant="auth" /></div></div>
        <div className="auth-stage-scrim" aria-hidden="true" />
        <div className="auth-stage-top"><Brand /></div>
        <div className="auth-stage-copy">
          <h2>Your next move is already in your data.</h2>
          <ul className="auth-points">
            <li>See what changed in your business</li>
            <li>Know what needs attention first</li>
            <li>Decide with confidence</li>
          </ul>
        </div>
      </aside>

      <main className="auth-main" id="main-content">
        <div className="auth-topline">
          <Link href="/" className="btn-ghost"><HiArrowLeft />Home</Link>
          <span className="auth-mobile-brand"><Brand /></span>
          <span className="text-label">{signup ? 'New workspace' : 'Welcome back'}</span>
        </div>
        <div className="auth-form-wrap">
          {children}
        </div>
        <p className="auth-footnote">Your data stays yours. The decisions do too.</p>
      </main>
    </div>
  );
}
