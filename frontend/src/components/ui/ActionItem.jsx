import { HiExclamationTriangle, HiExclamationCircle, HiInformationCircle, HiCheckCircle } from 'react-icons/hi2';

const TONE = {
  critical: { color: 'var(--critical)', Icon: HiExclamationTriangle, label: 'Critical' },
  warning: { color: 'var(--warning)', Icon: HiExclamationCircle, label: 'Warning' },
  info: { color: 'var(--accent)', Icon: HiInformationCircle, label: 'Suggestion' },
  success: { color: 'var(--success)', Icon: HiCheckCircle, label: 'Good' },
};

// One row in a "needs your attention" list: what happened → why it matters → what to do.
export default function ActionItem({ severity = 'info', title, why, meta, action }) {
  const t = TONE[severity] || TONE.info;
  return (
    <li className="action-item" style={{ '--tone': t.color }}>
      <span className="action-icon" aria-hidden="true"><t.Icon /></span>
      <div style={{ minWidth: 0 }}>
        <p className="action-title"><span className="visually-hidden">{t.label}: </span>{title}</p>
        {why && <p className="action-why">{why}</p>}
        {meta && <div className="action-meta">{meta}</div>}
      </div>
      {action && <div className="action-cta">{action}</div>}
    </li>
  );
}
