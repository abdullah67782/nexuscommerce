'use client';
import { useEffect } from 'react';
import { HiArrowPath } from 'react-icons/hi2';
import Brand from '../components/Brand';

export default function Error({ error, reset }) {
  useEffect(() => { console.error('Next.js caught an error:', error); }, [error]);
  return (
    <main className="empty-screen" id="main-content">
      <Brand />
      <p className="mono-label" style={{ color: 'var(--warning)', marginTop: 32 }}>A brief interruption</p>
      <h1>Let&apos;s try that <em className="serif-em">again.</em></h1>
      <p>{error?.message || 'We could not load this view. Try again to return to your workspace.'}</p>
      <button onClick={reset} className="btn-primary"><HiArrowPath />Try again</button>
    </main>
  );
}
