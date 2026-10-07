export default function Meter({ value = 0, max = 100, tone, tall = false, label }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(max, 1)) * 100));
  return (
    <div className={`meter ${tall ? 'meter-tall' : ''}`} style={tone ? { '--tone': tone } : undefined} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
