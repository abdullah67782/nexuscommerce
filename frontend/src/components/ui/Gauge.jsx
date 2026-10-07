// Arc gauge (240° sweep). value 0..100 or null → shows "—".
export default function Gauge({ value, size = 150, stroke = 6, label, tone, suffix = '', valueSize }) {
  const r = (size - stroke) / 2 - 4;
  const c = size / 2;
  const sweep = 240;
  const start = 90 + (360 - sweep) / 2; // degrees, measured clockwise from +x
  const arc = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const [sx, sy] = arc(start);
  const [ex, ey] = arc(start + sweep);
  const d = `M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`;
  const len = (Math.PI * 2 * r * sweep) / 360;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const color = tone || (value == null ? 'var(--subtle)' : value >= 80 ? 'var(--success)' : value >= 60 ? 'var(--warning)' : 'var(--danger)');
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const a = ((start + (sweep * i) / 10) * Math.PI) / 180;
    const r1 = r + stroke / 2 + 3, r2 = r1 + (i % 5 === 0 ? 6 : 3);
    return <line key={i} x1={c + r1 * Math.cos(a)} y1={c + r1 * Math.sin(a)} x2={c + r2 * Math.cos(a)} y2={c + r2 * Math.sin(a)} stroke="var(--border-strong)" />;
  });
  return (
    <div className="gauge" style={{ width: size, height: size * 0.86 }} role="img" aria-label={`${label || 'Score'}: ${value == null ? 'not available' : `${Math.round(value)}${suffix}`}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ marginTop: 0 }}>
        {ticks}
        <path d={d} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <path className="gauge-arc" d={d} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={len} strokeDashoffset={len * (1 - pct / 100)} />
      </svg>
      <div className="gauge-value" style={{ top: c }}>
        <strong style={{ fontSize: valueSize || size * 0.27 }}>{value == null ? '—' : `${Math.round(value)}${suffix}`}</strong>
        {label && <span>{label}</span>}
      </div>
    </div>
  );
}
