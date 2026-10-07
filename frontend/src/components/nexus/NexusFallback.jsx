import { useId } from 'react';
import { NEXUS_NODES, OUTPUT_IDS, layoutFor, CORE_COLOR, CORE_HOT, DATA_COLOR, BONE, DANGER } from './nexusConfig';

// Static SVG rendering of the Nexus. Shown on first paint, while three.js
// loads, and permanently when WebGL is unavailable.
export default function NexusFallback({ variant = 'hero', states, portrait = false }) {
  const uid = useId().replace(/:/g, '');
  const L = layoutFor(portrait ? 0.5 : 1.6);
  const W = portrait ? 600 : 1000;
  const cx = portrait ? 300 : variant === 'hero' ? 650 : 500;
  const cy = portrait ? 330 : variant === 'compact' ? 210 : 300;
  const k = variant === 'compact' ? 66 : portrait ? 62 : variant === 'hero' ? 68 : 84;
  const pt = id => [cx + L[id][0] * k, cy - L[id][1] * k];
  const core = pt('core');
  const data = pt('data');
  const curve = (a, b, bend) => {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return `M${a[0]} ${a[1]} Q${mx - dy * bend} ${my + dx * bend} ${b[0]} ${b[1]}`;
  };
  const streams = Array.from({ length: 11 }, (_, i) => {
    const s = (portrait ? cx - 260 : cy - 190) + i * (portrait ? 52 : 38) + ((i * 37) % 17);
    return curve(portrait ? [s, -40] : [-40, s], data, ((i % 5) - 2) * 0.06);
  });
  const H = portrait ? 1000 : variant === 'compact' ? 420 : 600;

  return (
    <svg className={`nexus-fallback ${portrait ? 'is-portrait' : 'is-landscape'}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio={variant === 'hero' ? 'xMidYMid slice' : 'xMidYMid meet'} role="presentation">
      <defs>
        <radialGradient id={`${uid}-core`}><stop offset="0" stopColor={CORE_COLOR} stopOpacity=".55" /><stop offset=".35" stopColor={CORE_COLOR} stopOpacity=".14" /><stop offset="1" stopColor={CORE_COLOR} stopOpacity="0" /></radialGradient>
        {NEXUS_NODES.map(n => <radialGradient key={n.id} id={`${uid}-${n.id}`}><stop offset="0" stopColor={n.color} stopOpacity=".42" /><stop offset="1" stopColor={n.color} stopOpacity="0" /></radialGradient>)}
      </defs>
      <g opacity=".5" fill="none" stroke={BONE} strokeOpacity=".09">
        {[150, 260, 380, 520].map(rx => <ellipse key={rx} cx={cx} cy={cy + k * 3.1} rx={rx} ry={rx * 0.16} />)}
      </g>
      <g fill="none" stroke={DATA_COLOR} strokeOpacity=".16" strokeWidth="1">
        {streams.map((d, i) => <path key={i} d={d} className="nexus-fallback-flow" style={{ animationDelay: `${-i * 0.7}s` }} />)}
      </g>
      <path d={curve(data, core, -0.12)} fill="none" stroke={DATA_COLOR} strokeOpacity=".55" />
      {OUTPUT_IDS.map((id, i) => {
        const n = NEXUS_NODES.find(x => x.id === id);
        return <path key={id} d={curve(core, pt(id), [0.16, -0.04, -0.18][i])} fill="none" stroke={n.color} strokeOpacity=".5" />;
      })}
      <circle cx={core[0]} cy={core[1]} r="150" fill={`url(#${uid}-core)`} />
      <polygon points={hexagon(core, 82)} fill="none" stroke={BONE} strokeOpacity=".14" />
      <polygon points={hexagon(core, 56, 0.5)} fill="none" stroke={CORE_COLOR} strokeOpacity=".7" />
      <circle cx={core[0]} cy={core[1]} r="22" fill={CORE_HOT} />
      <ellipse cx={core[0]} cy={core[1]} rx="160" ry="44" fill="none" stroke={BONE} strokeOpacity=".12" transform={`rotate(-14 ${core[0]} ${core[1]})`} />
      {NEXUS_NODES.map(n => {
        const [x, y] = pt(n.id);
        const st = states?.[n.id];
        return (
          <g key={n.id}>
            <circle cx={x} cy={y} r="70" fill={`url(#${uid}-${n.id})`} />
            <circle cx={x} cy={y} r="26" fill="none" stroke={n.color} strokeOpacity=".6" />
            {st?.alert && <circle cx={x} cy={y} r="38" fill="none" stroke={DANGER} strokeOpacity=".7" strokeDasharray="3 4" />}
            <rect x={x - 9} y={y - 9} width="18" height="18" fill="#151a1f" stroke={n.color} transform={`rotate(45 ${x} ${y})`} />
            <text x={x + 36} y={y + 4} className="nexus-fallback-label" fill={BONE}>{n.short}</text>
          </g>
        );
      })}
    </svg>
  );
}

function hexagon([x, y], r, rot = 0) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + rot;
    return `${(x + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');
}
