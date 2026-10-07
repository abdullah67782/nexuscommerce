// Shared definition of the Nexus network (landing scene + its SVG fallback).
// Labels are deliberately conceptual — the public site never names the
// product's internal modules. Raw data enters neutral, becomes teal inside
// the Nexus core, and leaves as three kinds of business signal.

export const NEXUS_NODES = [
  { id: 'data', role: 'input', label: 'Your commerce data', short: 'Data', color: '#8fa3ad', desc: 'Orders, products and stock — everything your store already knows.' },
  { id: 'signals', role: 'output', label: 'Signals', short: 'Signals', color: '#5b8cff', desc: 'Change, noticed early.' },
  { id: 'risks', role: 'output', label: 'Risks', short: 'Risks', color: '#e6a34a', desc: 'Problems, seen before they grow.' },
  { id: 'opportunities', role: 'output', label: 'Opportunities', short: 'Opportunities', color: '#4ccb83', desc: 'Where your next gain is likely to be.' },
];

export const DATA_COLOR = '#8fa3ad';
export const CORE_COLOR = '#20c7b7';
export const CORE_HOT = '#d9fbf7';
export const BONE = '#f3f5f4';
export const DANGER = '#ef6262';
export const OUTPUT_IDS = ['signals', 'risks', 'opportunities'];

export const nodeById = id => NEXUS_NODES.find(n => n.id === id);

// Positions for the two orientations. Flow reads left → right on wide
// screens and top → bottom on tall ones.
export function layoutFor(aspect) {
  if (aspect < 0.85) {
    return {
      portrait: true,
      core: [0, 0, 0],
      data: [0.15, 3.15, 0.2],
      signals: [-1.75, -2.55, 0.45],
      risks: [0.1, -3.25, -0.35],
      opportunities: [1.85, -2.45, 0.2],
    };
  }
  return {
    portrait: false,
    core: [0, 0, 0],
    data: [-3.7, 0.4, 0.35],
    signals: [3.15, 1.6, -0.55],
    risks: [3.65, -0.12, 0.6],
    opportunities: [2.95, -1.8, -0.3],
  };
}

// Camera stations along the landing narrative (p = scroll progress 0..1).
// focus: what the camera studies · dist: how close · sx/sy: where on screen
// the focus should sit (-1..1, + is right/up) so copy can live beside it.
export const HERO_STATIONS = [
  { p: 0.0, focus: 'center', dist: 15.2, sx: 0.5, sy: 0.02, elev: 0.9, azim: 0.0 },
  { p: 0.25, focus: 'data', dist: 7.4, sx: 0.44, sy: 0.0, elev: 0.55, azim: -0.42 },
  { p: 0.5, focus: 'core', dist: 6.8, sx: 0.44, sy: 0.0, elev: 1.05, azim: 0.18 },
  { p: 0.75, focus: 'outputs', dist: 10.2, sx: 0.5, sy: 0.0, elev: 0.6, azim: 0.42 },
  { p: 1.0, focus: 'center', dist: 15.4, sx: 0.5, sy: -0.06, elev: 3.4, azim: 0.0 },
];

export const PORTRAIT_STATIONS = [
  { p: 0.0, focus: 'center', dist: 15.5, sx: 0, sy: 0.22, elev: 0.8, azim: 0.0 },
  { p: 0.25, focus: 'data', dist: 8.0, sx: 0, sy: 0.3, elev: 0.5, azim: -0.3 },
  { p: 0.5, focus: 'core', dist: 7.6, sx: 0, sy: 0.3, elev: 1.0, azim: 0.2 },
  { p: 0.75, focus: 'outputs', dist: 9.6, sx: 0, sy: 0.3, elev: 0.6, azim: 0.3 },
  { p: 1.0, focus: 'center', dist: 17, sx: 0, sy: 0.2, elev: 3.0, azim: 0.0 },
];

export const STATIC_STATION = { focus: 'center', dist: 10.5, sx: 0, sy: 0, elev: 0.9, azim: 0 };

// ── maths ────────────────────────────────────────────────────────────────
export const clamp01 = v => Math.min(1, Math.max(0, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => t * t * (3 - 2 * t);
export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
// Bell-shaped emphasis around `center` with half-width `w`.
export const bell = (p, center, w) => clamp01(1 - Math.abs(p - center) / w);

// Narrative emphasis per element for a given scroll progress.
export function focusWeights(p) {
  return {
    data: Math.max(0.35, smooth(bell(p, 0.25, 0.22))),
    core: Math.max(0.45, smooth(bell(p, 0.5, 0.24))),
    signals: Math.max(0.35, smooth(clamp01((p - 0.6) / 0.08)) * (1 - 0.4 * smooth(clamp01((p - 0.92) / 0.08)))),
    risks: Math.max(0.35, smooth(clamp01((p - 0.67) / 0.08)) * (1 - 0.4 * smooth(clamp01((p - 0.92) / 0.08)))),
    opportunities: Math.max(0.35, smooth(clamp01((p - 0.74) / 0.08)) * (1 - 0.4 * smooth(clamp01((p - 0.92) / 0.08)))),
    streams: 0.45 + 0.55 * smooth(bell(p, 0.25, 0.3)),
    inflow: 0.5 + 0.5 * smooth(bell(p, 0.42, 0.25)),
    outflow: 0.35 + 0.65 * smooth(clamp01((p - 0.55) / 0.15)),
  };
}

// Interpolate camera stations for progress p.
export function stationAt(stations, p) {
  if (p <= stations[0].p) return stations[0];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (p <= b.p) {
      const t = smooth((p - a.p) / (b.p - a.p));
      return { a, b, t };
    }
  }
  return stations[stations.length - 1];
}

// Detect usable WebGL without keeping a context alive.
export function hasWebGL() {
  if (typeof window === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
