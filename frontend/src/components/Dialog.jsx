'use client';
import { useEffect, useRef } from 'react';

export default function Dialog({ children, onClose, labelledBy, describedBy, busy = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="product-dialog plate-ticks"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={event => { if (event.target === ref.current && !busy) onClose(); }}
    >
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
