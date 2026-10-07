// Compact circular score (0–100). Colour follows the score unless `tone` is given.
export default function ScoreRing({ value, size = 88, stroke = 7, label, tone, suffix = '' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const color = tone || (value == null ? 'var(--text-3)' : value >= 80 ? 'var(--success)' : value >= 60 ? 'var(--warning)' : 'var(--critical)');
  return (
    <div className="score-ring" style={{ width: size, height: size }} role="img" aria-label={`${label || 'Score'}: ${value == null ? 'not available' : `${Math.round(value)}${suffix}`}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle className="score-ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <div className="score-ring-value">
        <strong style={{ fontSize: Math.round(size * 0.26) }}>{value == null ? '—' : `${Math.round(value)}${suffix}`}</strong>
        {label && <span>{label}</span>}
      </div>
    </div>
  );
}
