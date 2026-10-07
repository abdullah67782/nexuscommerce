// Segmented control. Options: [{ value, label, count? }] or plain strings.
export default function Segmented({ options, value, onChange, label, size, fill = false, className = '' }) {
  const items = options.map(o => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  return (
    <div role="group" aria-label={label} className={`segmented ${size === 'lg' ? 'segmented-lg' : ''} ${fill ? 'segmented-fill' : ''} ${className}`}>
      {items.map(o => (
        <button key={o.value} type="button" aria-pressed={value === o.value} aria-label={o.ariaLabel} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
