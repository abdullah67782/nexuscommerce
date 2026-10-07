// KPI readouts: one ruled instrument band instead of a row of cards.
export function Readouts({ children, cols = 4, className = '', label }) {
  return <div className={`readouts ${className}`} style={{ '--cols': cols }} role="group" aria-label={label}>{children}</div>;
}

export function Readout({ label, value, suffix, detail, tone, icon, loading = false }) {
  return (
    <div className="readout" style={tone ? { '--tone': tone } : undefined}>
      <p className={`readout-label ${icon ? 'has-icon' : ''}`}>{icon}{label}</p>
      {loading
        ? <div className="skeleton" />
        : <p className="readout-value"><span className="num">{value ?? '—'}</span>{suffix && <span className="readout-suffix">{suffix}</span>}</p>}
      {detail && <div className="readout-detail">{detail}</div>}
    </div>
  );
}
