// SVG <defs> shared by charts: hatched confidence bands and soft area fades.
// Render inside a Recharts chart (Recharts passes <defs> straight through).
export default function HatchDefs({ id, color, fadeId, fadeColor }) {
  return (
    <defs>
      {id && (
        <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={color} fillOpacity="0.05" />
          <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeOpacity="0.35" strokeWidth="1" />
        </pattern>
      )}
      {fadeId && (
        <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fadeColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={fadeColor} stopOpacity="0" />
        </linearGradient>
      )}
    </defs>
  );
}
