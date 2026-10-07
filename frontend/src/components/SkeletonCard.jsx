export default function SkeletonCard({ height = 180, className = '' }) {
  return (
    <div className={`plate ${className}`} role="status" aria-label="Loading" style={{ padding: 20 }}>
      <div className="skeleton" style={{ height }} />
    </div>
  );
}
