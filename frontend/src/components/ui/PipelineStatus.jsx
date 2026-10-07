import Link from 'next/link';

// The product's core idea as a status line: Data → Model → Decisions.
// steps: [{ key, label, value, tone: 'ok'|'warning'|'critical'|'idle', href }]
const TONE = { ok: 'var(--accent)', warning: 'var(--warning)', critical: 'var(--critical)', idle: 'var(--text-3)' };

export default function PipelineStatus({ steps, label = 'Workspace status' }) {
  return (
    <ol className="pipeline-status" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.key} style={{ '--tone': TONE[s.tone] || TONE.idle }}>
          {i > 0 && <span className="pipeline-status-link" aria-hidden="true" />}
          <Link href={s.href} className="pipeline-status-step">
            <span className="pipeline-status-dot" aria-hidden="true" />
            <span className="pipeline-status-label">{s.label}</span>
            <span className="pipeline-status-value">{s.value}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
