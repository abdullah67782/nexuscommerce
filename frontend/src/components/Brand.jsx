import Link from 'next/link';

// Mark: inbound data → Nexus core → three outbound signals.
export function BrandMark({ className = '' }) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <svg viewBox="0 0 28 28" fill="none">
        <path d="M2 14h7.5" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="14" cy="14" r="4.2" fill="#20c7b7" />
        <circle cx="14" cy="14" r="7" stroke="#20c7b7" strokeOpacity=".35" strokeWidth="1.2" />
        <path d="M19.2 10.6l5-4.6M20.6 14h5.4M19.2 17.4l5 4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export default function Brand({ compact = false, href = '/' }) {
  return (
    <Link href={href} className="brand" aria-label="NexusCommerce home">
      <BrandMark />
      {!compact && <span className="brand-word">Nexus<span>Commerce</span></span>}
    </Link>
  );
}
