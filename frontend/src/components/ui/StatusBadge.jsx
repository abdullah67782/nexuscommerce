// tone: critical | warning | success | info | accent | neutral
const MAP = { critical: 'status-critical', high: 'status-warning', warning: 'status-warning', medium: 'status-info', info: 'status-info', low: 'status-success', success: 'status-success', ok: 'status-success', accent: 'status-accent', neutral: 'status-neutral' };

export default function StatusBadge({ tone = 'neutral', children, className = '', ...rest }) {
  return <span className={`status ${MAP[tone] || MAP.neutral} ${className}`} {...rest}>{children}</span>;
}
