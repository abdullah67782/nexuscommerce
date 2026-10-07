'use client';
import { Component, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import NexusScene from './NexusScene';
import { NEXUS_NODES } from './nexusConfig';

// The only file that pulls three.js + R3F into a bundle. Loaded lazily by
// NexusStage, used only on the public landing page.
//
// Render budget: DPR ≤ 1.25 (1 on small/touch screens), antialias only at
// DPR 1, ~40 particles (20 on small screens). Rendering stops entirely when
// the stage is off-screen or the tab is hidden; under reduced motion the
// scene renders on demand (scroll/resize only).

class SceneBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.warn('Nexus scene disabled, showing static fallback:', error?.message); this.props.onFail?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}

function pickBudget() {
  const small = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const dpr = Math.min(window.devicePixelRatio || 1, small ? 1 : 1.25);
  return { small, dpr, antialias: dpr <= 1 && !small, particles: small ? 20 : 40 };
}

export default function NexusCanvas({ progressRef, hovered = null, onHover, reduced = false, onReady, onFail }) {
  const wrapRef = useRef(null);
  const labelsRef = useRef({});
  const hoveredRef = useRef(hovered);
  const pointerRef = useRef({ x: 0, y: 0 });
  const invalidateRef = useRef(null);
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => !document.hidden);
  const [budget] = useState(pickBudget);

  useEffect(() => { hoveredRef.current = hovered; invalidateRef.current?.(); }, [hovered]);

  // Off-screen → stop rendering.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: '40px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Hidden tab → stop rendering.
  useEffect(() => {
    const onVis = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Window-level pointer for parallax (copy overlays the canvas). Desktop only.
  useEffect(() => {
    if (reduced || budget.small) return undefined;
    const move = e => {
      pointerRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointerRef.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => window.removeEventListener('pointermove', move);
  }, [reduced, budget.small]);

  // Reduced motion: render only when scroll position or size changes.
  useEffect(() => {
    if (!reduced) return undefined;
    const redraw = () => invalidateRef.current?.();
    window.addEventListener('scroll', redraw, { passive: true });
    window.addEventListener('resize', redraw);
    return () => { window.removeEventListener('scroll', redraw); window.removeEventListener('resize', redraw); };
  }, [reduced]);

  const active = inView && tabVisible;

  return (
    <div ref={wrapRef} className="nexus-canvas-wrap">
      <SceneBoundary onFail={onFail}>
        <Canvas
          className="nexus-canvas"
          frameloop={!active ? 'never' : reduced ? 'demand' : 'always'}
          dpr={budget.dpr}
          gl={{ antialias: budget.antialias, alpha: true, powerPreference: 'default', stencil: false, depth: true }}
          camera={{ fov: 38, near: 0.1, far: 60, position: [0, 1, 16] }}
          onCreated={state => {
            invalidateRef.current = state.invalidate;
            state.gl.setClearColor(0x000000, 0);
            state.gl.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); onFail?.(); }, { once: true });
          }}
        >
          <NexusScene
            progressRef={progressRef}
            hoveredRef={hoveredRef}
            onHover={onHover}
            labelsRef={labelsRef}
            pointerRef={pointerRef}
            reduced={reduced}
            particles={budget.particles}
            onFirstFrame={onReady}
          />
        </Canvas>
      </SceneBoundary>
      <div className="nexus-labels">
        {NEXUS_NODES.map(n => (
          <div key={n.id} ref={el => { labelsRef.current[n.id] = el; }} className="nexus-label" style={{ '--tone': n.color, opacity: 0 }}>
            <span className="nexus-label-name">{n.short}</span>
            <span className="nexus-label-desc">{n.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
