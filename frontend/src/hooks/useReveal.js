'use client';
import { useEffect } from 'react';

// Adds `.is-visible` to every [data-reveal] element inside `rootRef` as it
// enters the viewport. CSS in globals.css handles the motion (and disables it
// under prefers-reduced-motion).
export function useReveal(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const items = root.querySelectorAll('[data-reveal]');
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
    items.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [rootRef]);
}
