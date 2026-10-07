'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import NexusFallback from './NexusFallback';
import { hasWebGL } from './nexusConfig';
import { useReducedMotion } from '../../hooks/useReducedMotion';

// three.js + R3F live in their own chunk, fetched only when the stage is near
// the viewport and the browser is idle. The SVG fallback is visible from the
// first paint and stays if WebGL is unavailable or the context is lost.
const NexusCanvas = dynamic(() => import('./NexusCanvas'), { ssr: false, loading: () => null });

export default function NexusStage({ variant = 'hero', className = '', ...props }) {
  const ref = useRef(null);
  const reduced = useReducedMotion();
  const [mode, setMode] = useState('pending'); // pending | webgl | fallback (pending also shows the SVG)
  const [ready, setReady] = useState(false);
  const [fallbackGone, setFallbackGone] = useState(false);

  // Once the canvas has faded in, drop the SVG from the DOM entirely so it
  // costs nothing (it is re-shown if the WebGL context is lost).
  useEffect(() => {
    if (!ready) return undefined;
    const t = setTimeout(() => setFallbackGone(true), 1600);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!hasWebGL()) return undefined; // stays on the SVG fallback
    let idle, timer;
    const start = () => setMode(m => (m === 'pending' ? 'webgl' : m));
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(start, { timeout: 900 });
      else timer = setTimeout(start, 150);
    }, { rootMargin: '240px' });
    io.observe(ref.current);
    return () => { io.disconnect(); if (idle) window.cancelIdleCallback?.(idle); clearTimeout(timer); };
  }, []);

  return (
    <div ref={ref} className={`nexus-stage nexus-${variant} ${ready ? 'is-ready' : ''} ${className}`} aria-hidden="true">
      {!fallbackGone && (
        <div className="nexus-fallback-layer">
          <NexusFallback variant={variant} />
          {variant === 'hero' && <NexusFallback variant={variant} portrait />}
        </div>
      )}
      {mode === 'webgl' && (
        <NexusCanvas
          {...props}
          variant={variant}
          reduced={reduced}
          onReady={() => setReady(true)}
          onFail={() => { setReady(false); setFallbackGone(false); setMode('fallback'); }}
        />
      )}
    </div>
  );
}
