import { useId } from 'react';
import { HiArrowUpRight, HiCheck, HiCube, HiChartBar } from 'react-icons/hi2';

// Deliberately illustrative: this is a public product preview, never live account data.
export default function ProductPreview({ compact = false }) {
  const id = useId().replace(/:/g, '');
  return <div className={`product-scene ${compact ? 'product-scene-compact' : ''}`}>
    <div className="preview-backplate" aria-hidden="true" />
    <div className="product-preview">
      <div className="preview-toolbar"><span><span className="status-dot" />Business overview</span><span className="preview-label">ILLUSTRATIVE DATA</span></div>
      <div className="preview-head"><div><p className="eyebrow">Your next 30 days</p><h3>A clearer view ahead.</h3></div><span className="preview-icon"><HiChartBar /></span></div>
      <div className="preview-metrics"><div><span>Projected demand</span><strong>2,840<small> units</small></strong></div><div><span>Inventory health</span><strong>86<small> /100</small></strong></div><div><span>Opportunities</span><strong>12<small> products</small></strong></div></div>
      <div className="preview-chart-label"><span>Demand outlook</span><span><i />Sales <i className="forecast-dot" />Forecast</span></div>
      <svg className="preview-chart" viewBox="0 0 600 205" role="img" aria-label="Illustrative demand chart showing historical sales followed by a rising forecast and confidence range">
        <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#6caeff" stopOpacity=".18"/><stop offset="1" stopColor="#6caeff" stopOpacity="0"/></linearGradient></defs>
        {[35,85,135,185].map(y => <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#ffffff" strokeOpacity=".055"/>)}
        <path d="M0 162L24 154L48 170L72 132L96 142L120 115L144 130L168 102L192 122L216 95L240 108L264 73L288 91L312 63L336 80L360 59L384 72L408 44L432 55L456 35L480 46L504 27L528 36L552 17L576 28L600 10V205H0Z" fill={`url(#${id}-fill)`}/>
        <path d="M360 59L408 23L456 14L504 8L552 0L600 0V52L552 60L504 65L456 79L408 85L360 59Z" fill="#73baff" opacity=".12"/>
        <line x1="360" x2="360" y1="8" y2="205" stroke="#a8bad1" strokeOpacity=".25" strokeDasharray="4 5"/>
        <path d="M0 162L24 154L48 170L72 132L96 142L120 115L144 130L168 102L192 122L216 95L240 108L264 73L288 91L312 63L336 80L360 59" fill="none" stroke="#72b3fb" strokeWidth="2.5" strokeLinejoin="round"/>
        <path d="M360 59L384 72L408 44L432 55L456 35L480 46L504 27L528 36L552 17L576 28L600 10" fill="none" stroke="#9cb9e8" strokeWidth="2.5" strokeDasharray="5 5"/>
        <circle cx="360" cy="59" r="5" fill="#b8dfff" stroke="#243b55" strokeWidth="4"/>
      </svg>
      <div className="preview-axis"><span>WEEK 01</span><span>WEEK 02</span><span>WEEK 03</span><span>WEEK 04</span></div>
      <div className="preview-insight"><span className="insight-symbol"><HiCube /></span><div><strong>Stay one step ahead</strong><p>Spot demand shifts before they become stockouts.</p></div><HiArrowUpRight className="shrink-0" /></div>
    </div>
    {!compact && <div className="preview-float"><span><HiCheck /></span><div><strong>Clarity at every step</strong><p>From sales data to your next decision</p></div></div>}
  </div>;
}
