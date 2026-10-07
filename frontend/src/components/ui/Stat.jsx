import { HiArrowTrendingUp, HiArrowTrendingDown, HiMinus } from 'react-icons/hi2';

// Delta: signed % change. `goodWhenUp` decides the colour, not the arrow.
export function Delta({ value, goodWhenUp = true, suffix = '%', label }) {
  if (value == null || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.5;
  const up = value > 0;
  const tone = flat ? 'delta-flat' : (up === goodWhenUp ? 'delta-up' : 'delta-down');
  const Icon = flat ? HiMinus : up ? HiArrowTrendingUp : HiArrowTrendingDown;
  return (
    <span className={`delta ${tone}`}>
      <Icon aria-hidden="true" />
      {up && !flat ? '+' : ''}{value.toFixed(Math.abs(value) < 10 ? 1 : 0)}{suffix}
      {label && <span className="text-faint" style={{ fontWeight: 400, marginLeft: 3 }}>{label}</span>}
    </span>
  );
}

// Stat: label · value (+unit) · optional delta/hint. size="lg" for the few figures that matter most.
export default function Stat({ label, value, unit, delta, hint, tone, size, loading = false }) {
  return (
    <div className={`stat ${size === 'lg' ? 'stat-lg' : ''}`}>
      <p className="stat-label">{tone && <span className="dot" style={{ '--tone': tone }} />}{label}</p>
      {loading
        ? <div className="skeleton" style={{ height: size === 'lg' ? 34 : 24, width: '60%' }} />
        : <p className="stat-value"><span>{value ?? '—'}</span>{unit && <span className="stat-unit">{unit}</span>}</p>}
      {(delta || hint) && !loading && <p className="stat-hint">{delta}{delta && hint ? ' ' : ''}{hint}</p>}
    </div>
  );
}
