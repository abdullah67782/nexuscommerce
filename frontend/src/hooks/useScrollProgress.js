'use client';
import { useEffect, useRef, useState } from 'react';

// Tracks how far the viewport has travelled through `targetRef` (0..1).
// The value lives in a ref so the 3D scene can read it every frame without
// React re-renders; `--progress` is mirrored onto the element for CSS, and
// `chapter` (a coarse index) is the only thing exposed as state.
export function useScrollProgress(targetRef, chapters = 5) {
  const progressRef = useRef(0);
  const [chapter, setChapter] = useState(0);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      const p = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
      progressRef.current = p;
      el.style.setProperty('--progress', p.toFixed(4));
      const next = Math.min(chapters - 1, Math.round(p * (chapters - 1)));
      setChapter(c => (c === next ? c : next));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [targetRef, chapters]);

  return { progressRef, chapter };
}
