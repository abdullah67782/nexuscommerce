import { useId } from 'react';

// Lightweight hover/focus tooltip (CSS only). Wrap a focusable element.
export default function Tooltip({ label, children }) {
  const id = `tt${useId().replace(/:/g, '')}`;
  return (
    <span className="tooltip" aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="tooltip-bubble">{label}</span>
    </span>
  );
}
