export default function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(item => !Array.isArray(item.value) && item.dataKey !== 'bounds' && item.name);
  return (
    <div className="chart-tooltip">
      <p>{labelFormatter ? labelFormatter(label, payload) : label}</p>
      {rows.map((item, i) => (
        <div key={`${item.dataKey}-${i}`}>
          <span className="chart-tooltip-dot" style={{ background: item.color || item.stroke || item.fill }} />
          <span>{item.name}</span>
          <strong>{valueFormatter ? valueFormatter(item.value) : Number(item.value).toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}
