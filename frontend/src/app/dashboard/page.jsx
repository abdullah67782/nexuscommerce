'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import ProtectedRoute from '../../components/ProtectedRoute';
import PageHeader from '../../components/PageHeader';
import ChartTooltip from '../../components/ChartTooltip';
import { Panel, PanelHeader } from '../../components/ui/Panel';
import Button from '../../components/ui/Button';
import Stat, { Delta } from '../../components/ui/Stat';
import StatusBadge from '../../components/ui/StatusBadge';
import ActionItem from '../../components/ui/ActionItem';
import ScoreRing from '../../components/ui/ScoreRing';
import Meter from '../../components/ui/Meter';
import EmptyState from '../../components/ui/EmptyState';
import Skeleton from '../../components/ui/Skeleton';
import PipelineStatus from '../../components/ui/PipelineStatus';
import { C, axisProps, gridProps, cursorProps } from '../../components/charts/chartTheme';
import api from '../../services/api';
import {
  HiOutlineArrowPath, HiArrowRight, HiOutlineChartBar, HiOutlineShieldCheck, HiOutlineSparkles,
  HiArrowTrendingUp, HiArrowTrendingDown, HiMinus, HiOutlineArrowUpTray,
} from 'react-icons/hi2';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v || 0);
const fmtNum = (v) => (v ?? 0).toLocaleString();
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
const DAY = 86400000;
const RISK_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const RISK_TONE = { critical: 'critical', high: 'warning', medium: 'info', low: 'success' };

// Sum units in [from, to] (inclusive, by calendar day) from the sales series.
function windowSum(rows, from, to) {
  let s = 0;
  for (const r of rows) {
    const t = new Date(r.sale_date).getTime();
    if (t >= from && t <= to) s += Number(r.quantity) || 0;
  }
  return s;
}

// Recent momentum derived from recorded sales (not a model forecast).
function salesMomentum(rows) {
  if (!rows?.length) return null;
  const last = Math.max(...rows.map(r => new Date(r.sale_date).getTime()));
  const last7 = windowSum(rows, last - 6 * DAY, last);
  const prev7 = windowSum(rows, last - 13 * DAY, last - 7 * DAY);
  const last28 = windowSum(rows, last - 27 * DAY, last);
  const weekChange = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : null;
  const vsMonth = last28 > 0 ? ((last7 / 7) / (last28 / 28) - 1) * 100 : null;
  const direction = vsMonth == null ? 'unknown' : vsMonth > 5 ? 'up' : vsMonth < -5 ? 'down' : 'flat';
  return { last7, prev7, weekChange, vsMonth, direction, lastDate: last };
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [hour, setHour] = useState(() => new Date().getHours());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [stats, setStats] = useState({ totalProducts: 0, totalSales: 0, totalRevenue: 0, qualityScore: 0 });
  const [salesData, setSalesData] = useState([]);
  const [products, setProducts] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [quality, setQuality] = useState({ score: 0, clean_records: 0, duplicates: 0, outliers: 0, last_upload: null });
  const [freshness, setFreshness] = useState(null);
  const [criticalAnomalies, setCriticalAnomalies] = useState(0);
  const [versionInfo, setVersionInfo] = useState(null);

  const [selectedProduct, setSelectedProduct] = useState('all');
  const [dateRange, setDateRange] = useState('90');

  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 60000);
    return () => clearInterval(t);
  }, []);

  const fetchSales = async (product, range) => {
    try {
      const r = await api.get('/sales', { params: { product, range } });
      setSalesData(r.data?.sales || []);
    } catch {}
  };

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const [statsR, prodsR, metricsR, alertsR, qualityR, freshnessR, anomR, versionsR] = await Promise.allSettled([
        api.get('/dashboard/stats'),
        api.get('/products'),
        api.get('/forecast/metrics'),
        api.get('/inventory/alerts'),
        api.get('/data/quality'),
        api.get('/data/freshness'),
        api.get('/data/anomalies?severity=critical&resolved=false'),
        api.get('/data/versions'),
      ]);

      if (statsR.status === 'fulfilled') {
        const d = statsR.value.data || {};
        setStats({ totalProducts: d.total_products || 0, totalSales: d.total_sales_records || 0, totalRevenue: d.total_revenue || 0, qualityScore: d.latest_quality_score || 0 });
        setCriticalAnomalies(d.critical_anomalies || 0);
      }
      if (prodsR.status === 'fulfilled') setProducts(prodsR.value.data?.products || []);
      if (metricsR.status === 'fulfilled') setMetrics(metricsR.value.data || []);
      if (alertsR.status === 'fulfilled') setAlerts(alertsR.value.data || []);
      if (qualityR.status === 'fulfilled') setQuality(q => qualityR.value.data || q);
      if (freshnessR.status === 'fulfilled') setFreshness(freshnessR.value.data);
      if (anomR.status === 'fulfilled') setCriticalAnomalies(anomR.value.data?.total ?? 0);
      if (versionsR.status === 'fulfilled') {
        const versions = versionsR.value.data?.versions || [];
        const latest = versions.find((v) => !v.is_rolled_back);
        if (latest) setVersionInfo(latest);
      }

      await fetchSales(selectedProduct, dateRange);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedProduct, dateRange]);

  useEffect(() => { fetchAll(); const t = setInterval(() => fetchAll(true), 60000); return () => clearInterval(t); }, [fetchAll]);
  useEffect(() => { if (!loading) fetchSales(selectedProduct, dateRange); }, [selectedProduct, dateRange]); // eslint-disable-line

  // ── Derived signals (all from the responses above) ──────────────────────
  const qualityScore = Math.round(quality.score || quality.quality_score || 0);
  const accuracy = !Array.isArray(metrics) && metrics?.accuracy != null ? metrics.accuracy : null;
  const hasPersonalModel = accuracy != null;
  const alertList = useMemo(() => (Array.isArray(alerts) ? [...alerts].sort((a, b) => (RISK_ORDER[a.risk_level?.toLowerCase()] ?? 9) - (RISK_ORDER[b.risk_level?.toLowerCase()] ?? 9)) : []), [alerts]);
  const criticalAlerts = alertList.filter(a => a.risk_level?.toLowerCase() === 'critical');
  const highAlerts = alertList.filter(a => a.risk_level?.toLowerCase() === 'high');
  const momentum = useMemo(() => salesMomentum(salesData), [salesData]);
  const freshScore = freshness?.freshness_score ?? null;
  const daysOld = freshness?.days_since_upload;
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const rangeTotal = useMemo(() => salesData.reduce((s, r) => s + (Number(r.quantity) || 0), 0), [salesData]);
  const rangeDays = salesData.length || 0;

  // Ranked "needs your attention": what happened → why it matters → what to do.
  const attention = useMemo(() => {
    const items = [];
    if (criticalAnomalies > 0) {
      items.push({ id: 'anomalies', severity: 'critical', title: `${criticalAnomalies} critical data ${criticalAnomalies === 1 ? 'issue' : 'issues'} in your uploads`, why: 'Rows with invalid dates or negative values were set aside, so totals and forecasts may be missing some sales.', action: { label: 'Review issues', href: '/upload' } });
    }
    criticalAlerts.slice(0, 3).forEach(a => items.push({
      id: `crit-${a.product_id ?? a.product_name}`, severity: 'critical',
      title: `${a.product_name} is down to ${fmtNum(a.stock_level)} units`,
      why: `That is below its reorder point of ${fmtNum(a.reorder_threshold)}. ${a.recommended_action || 'Restock soon to avoid missed sales.'}`,
      action: { label: 'Plan restock', href: '/inventory' },
    }));
    if (criticalAlerts.length > 3) items.push({ id: 'crit-more', severity: 'critical', title: `${criticalAlerts.length - 3} more products at critical stock`, why: 'Review the full list to decide what to reorder first.', action: { label: 'Open inventory', href: '/inventory' } });
    if (highAlerts.length) {
      items.push({ id: 'high', severity: 'warning', title: `${highAlerts.length} ${highAlerts.length === 1 ? 'product is' : 'products are'} close to running low`, why: `${highAlerts.slice(0, 3).map(a => a.product_name).join(', ')}${highAlerts.length > 3 ? '…' : ''} — schedule a reorder this week to stay ahead of demand.`, action: { label: 'Review stock', href: '/inventory' } });
    }
    if (momentum?.weekChange != null && Math.abs(momentum.weekChange) >= 20) {
      const down = momentum.weekChange < 0;
      items.push({ id: 'trend', severity: down ? 'warning' : 'info', title: `Units sold ${down ? 'fell' : 'rose'} ${Math.abs(momentum.weekChange).toFixed(0)}% compared with the previous week`, why: `${fmtNum(momentum.last7)} units in the last 7 days versus ${fmtNum(momentum.prev7)} the week before${selectedProduct !== 'all' ? ' for the selected product' : ''}. ${down ? 'Check whether stock-outs, pricing or seasonality explain the drop.' : 'Make sure stock can keep up if this continues.'}`, action: { label: 'View trend', href: '#performance' } });
    }
    if (freshScore != null && freshScore < 70) {
      items.push({ id: 'fresh', severity: freshScore < 40 ? 'warning' : 'info', title: daysOld != null ? `Your sales data is ${daysOld} ${daysOld === 1 ? 'day' : 'days'} old` : 'Your sales data is getting old', why: 'Alerts and forecasts are only as current as your last upload.', action: { label: 'Upload new data', href: '/upload' } });
    }
    if (qualityScore > 0 && qualityScore < 80) {
      items.push({ id: 'quality', severity: 'warning', title: `Data quality is ${qualityScore}/100`, why: 'Duplicates and rejected rows make totals and forecasts less reliable.', action: { label: 'See quality report', href: '/upload' } });
    }
    if (!hasPersonalModel) {
      items.push({ id: 'model', severity: 'info', title: 'Forecasts use the general base model', why: 'Training on your own sales history adapts forecasts to your store’s patterns. It takes a few minutes.', action: { label: 'Train model', href: '/forecasting' } });
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [criticalAnomalies, criticalAlerts, highAlerts, momentum, freshScore, daysOld, qualityScore, hasPersonalModel, selectedProduct]);

  const criticalCount = attention.filter(i => i.severity === 'critical').length;

  const pipeline = [
    { key: 'data', label: 'Data', href: '/upload', tone: freshScore == null ? 'idle' : freshScore >= 70 ? 'ok' : freshScore >= 40 ? 'warning' : 'critical', value: freshScore == null ? 'No uploads' : `${freshScore >= 70 ? 'Fresh' : freshScore >= 40 ? 'Aging' : 'Stale'}${daysOld != null ? ` · ${daysOld === 0 ? 'today' : `${daysOld}d ago`}` : ''}` },
    { key: 'model', label: 'Model', href: '/forecasting', tone: hasPersonalModel ? 'ok' : 'idle', value: hasPersonalModel ? `Personalised · ${accuracy}%` : 'Base model' },
    { key: 'decisions', label: 'Alerts', href: '/inventory', tone: criticalCount ? 'critical' : attention.length ? 'warning' : 'ok', value: attention.length ? `${attention.length} open${criticalCount ? ` · ${criticalCount} critical` : ''}` : 'All clear' },
  ];

  const MomentumIcon = momentum?.direction === 'up' ? HiArrowTrendingUp : momentum?.direction === 'down' ? HiArrowTrendingDown : HiMinus;
  const momentumText = !momentum || momentum.vsMonth == null ? 'Not enough recent sales to read a direction.'
    : momentum.direction === 'flat' ? 'Daily sales over the last 7 days are in line with the 4-week average.'
    : `Daily sales over the last 7 days are ${Math.abs(momentum.vsMonth).toFixed(0)}% ${momentum.direction === 'up' ? 'above' : 'below'} the 4-week average.`;

  return (
    <ProtectedRoute>
      <div className="page overview">
        <PageHeader
          eyebrow="Overview"
          title={`${greeting}, ${user?.name?.split(' ')[0] || 'there'}`}
          meta={loading ? <Skeleton height={28} width={420} /> : <PipelineStatus steps={pipeline} />}
        >
          <Button variant="secondary" onClick={() => fetchAll(true)} disabled={refreshing} icon={<HiOutlineArrowPath className={refreshing ? 'spin' : ''} />}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </PageHeader>

        {/* ── 1. Needs your attention ─────────────────────────────────── */}
        <section className="attention" aria-labelledby="attention-title">
          <div className="group-head">
            <h2 id="attention-title" className="text-section">Needs your attention</h2>
            {!loading && attention.length > 0 && <StatusBadge tone={criticalCount ? 'critical' : 'warning'}>{attention.length} {attention.length === 1 ? 'item' : 'items'}</StatusBadge>}
            <p className="group-head-note">Ranked by urgency, from your latest data</p>
          </div>
          <Panel className="attention-panel">
            {loading ? (
              <div className="panel-body" style={{ display: 'grid', gap: 12 }}><Skeleton height={44} /><Skeleton height={44} /><Skeleton height={44} /></div>
            ) : attention.length ? (
              <ul className="action-list">
                {attention.map(item => (
                  <ActionItem
                    key={item.id}
                    severity={item.severity}
                    title={item.title}
                    why={item.why}
                    action={<Button variant={item.severity === 'critical' ? 'primary' : 'secondary'} size="sm" href={item.action.href} iconRight={<HiArrowRight />}>{item.action.label}</Button>}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<HiOutlineShieldCheck />} title="Nothing needs your attention">Stock levels, data quality and your model all look healthy.</EmptyState>
            )}
          </Panel>
        </section>

        {/* ── 2. Performance + outlook ────────────────────────────────── */}
        <div className="overview-main">
          <Panel as="section" id="performance" aria-labelledby="performance-title">
            <PanelHeader title="Business performance" titleId="performance-title" description="Units sold per day">
              <select aria-label="Filter sales by product" value={selectedProduct} onChange={(e) => setSelectedProduct(e.target.value)} className="select-field select-sm" style={{ width: 'auto', maxWidth: 220 }}>
                <option value="all">All products</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select aria-label="Sales date range" value={dateRange} onChange={(e) => setDateRange(e.target.value)} className="select-field select-sm" style={{ width: 'auto' }}>
                {[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </PanelHeader>
            <div className="panel-body">
              <div className="perf-stats">
                <Stat size="lg" label="Units in this view" value={fmtNum(rangeTotal)} loading={loading} hint={rangeDays ? `${rangeDays} days of sales` : undefined} />
                <Stat size="lg" label="Last 7 days" value={momentum ? fmtNum(momentum.last7) : '—'} loading={loading} delta={momentum?.weekChange != null ? <Delta value={momentum.weekChange} label="vs previous week" /> : null} />
                <Stat size="lg" label="Daily average" value={rangeDays ? fmtNum(Math.round(rangeTotal / rangeDays)) : '—'} unit="units" loading={loading} />
              </div>
              <div className="chart-box" style={{ height: 300 }}>
                {loading ? <Skeleton height="100%" /> : salesData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={salesData} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                      <defs>
                        <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={C.accent} stopOpacity={0.16} />
                          <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...gridProps} />
                      <XAxis dataKey="sale_date" tickFormatter={fmtDate} {...axisProps} dy={8} minTickGap={28} />
                      <YAxis {...axisProps} dx={-4} width={48} />
                      <Tooltip content={<ChartTooltip labelFormatter={fmtDate} valueFormatter={v => `${Number(v).toLocaleString()} units`} />} cursor={cursorProps} />
                      <Area type="monotone" dataKey="quantity" stroke="none" fill="url(#salesFill)" legendType="none" tooltipType="none" isAnimationActive={false} />
                      <Line type="monotone" dataKey="quantity" stroke={C.accent} strokeWidth={2} dot={false} name="Units sold" activeDot={{ r: 4, strokeWidth: 2, stroke: '#111519', fill: C.accent }} animationDuration={600} />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : <EmptyState icon={<HiOutlineChartBar />} title="No sales in this view">Try another product or a longer date range.</EmptyState>}
              </div>
            </div>
          </Panel>

          <Panel as="section" variant="subtle" className="outlook" aria-labelledby="outlook-title">
            <PanelHeader title="Outlook" titleId="outlook-title" description="What the system expects, and how much to trust it" />
            <div className="panel-body outlook-body">
              {loading ? <Skeleton height={220} /> : (
                <>
                  <div className="outlook-block">
                    <p className="text-label">Recent direction</p>
                    <p className={`outlook-direction is-${momentum?.direction || 'unknown'}`}><MomentumIcon aria-hidden="true" />{momentum?.direction === 'up' ? 'Rising' : momentum?.direction === 'down' ? 'Falling' : momentum?.direction === 'flat' ? 'Steady' : 'Unclear'}</p>
                    <p className="outlook-note">{momentumText}</p>
                    <p className="outlook-source">Based on recorded sales{selectedProduct !== 'all' ? ' for the selected product' : ''}.</p>
                  </div>

                  <div className="outlook-block outlook-model">
                    {Array.isArray(metrics) && metrics.length > 0 ? (
                      <ul className="row-list" style={{ width: '100%' }}>
                        {metrics.slice(0, 3).map((m, i) => (
                          <li key={i} className="list-row" style={{ padding: '10px 0' }}>
                            <div className="list-row-main">
                              <p className="list-row-title">{m.model_name}</p>
                              <p className="list-row-meta"><span>MAE {Number(m.mae).toFixed(2)}</span><span>R² {Number(m.r2_score).toFixed(3)}</span></p>
                            </div>
                            {i === 0 && <StatusBadge tone="success">Best</StatusBadge>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <>
                        <ScoreRing value={accuracy} size={84} suffix="%" label="accuracy" tone={accuracy == null ? undefined : 'var(--accent)'} />
                        <div style={{ minWidth: 0 }}>
                          <p className="outlook-model-title">{hasPersonalModel ? 'Personalised forecast model' : 'General base model'}</p>
                          <p className="outlook-note">{hasPersonalModel ? `Measured on your own sales history${metrics.last_trained ? ` · trained ${fmtDate(metrics.last_trained)}` : ''}.` : 'Train a model on your store’s history to see its accuracy here.'}</p>
                        </div>
                      </>
                    )}
                  </div>

                  <Button variant={hasPersonalModel ? 'secondary' : 'primary'} href="/forecasting" block icon={<HiOutlineSparkles />}>
                    {hasPersonalModel ? 'Open demand forecast' : 'Train your model'}
                  </Button>
                </>
              )}
            </div>
          </Panel>
        </div>

        {/* ── 3. Key figures (compact) ────────────────────────────────── */}
        <section className="figures" aria-label="Key business figures">
          <Stat label="Products" value={fmtNum(stats.totalProducts)} loading={loading} />
          <Stat label="Sales records" value={fmtNum(stats.totalSales)} loading={loading} />
          <Stat label="Revenue" value={fmt(stats.totalRevenue)} loading={loading} />
          <Stat label="Data quality" value={stats.qualityScore || 0} unit="/ 100" loading={loading} tone={stats.qualityScore >= 80 ? 'var(--success)' : 'var(--warning)'} hint={stats.qualityScore >= 80 ? 'Good' : 'Needs improvement'} />
        </section>

        {/* ── 4. Risks + data health ──────────────────────────────────── */}
        <div className="overview-bottom">
          <Panel as="section" aria-labelledby="risks-title">
            <PanelHeader title="Inventory risks" titleId="risks-title" description="Products at or below their reorder point, most urgent first">
              <Button variant="ghost" size="sm" href="/inventory" iconRight={<HiArrowRight />}>All inventory</Button>
            </PanelHeader>
            {loading ? <div className="panel-body"><Skeleton height={140} /></div> : alertList.length ? (
              <div className="table-scroll" style={{ maxHeight: 340 }}>
                <table className="data-table">
                  <thead>
                    <tr><th>Product</th><th style={{ width: '32%' }}>Stock vs reorder point</th><th>Risk</th><th>Next step</th></tr>
                  </thead>
                  <tbody>
                    {alertList.map((a, i) => {
                      const tone = RISK_TONE[a.risk_level?.toLowerCase()] || 'info';
                      return (
                        <tr key={i}>
                          <td className="is-strong">{a.product_name}</td>
                          <td>
                            <div className="stock-cell">
                              <span className="num"><strong>{fmtNum(a.stock_level)}</strong> / {fmtNum(a.reorder_threshold)}</span>
                              <Meter value={a.stock_level} max={Math.max(a.reorder_threshold || 1, 1)} tone={`var(--${tone === 'info' ? 'info' : tone})`} label={`${a.product_name} stock against reorder point`} />
                            </div>
                          </td>
                          <td><StatusBadge tone={tone} className="is-cap">{String(a.risk_level || '').toLowerCase()}</StatusBadge></td>
                          <td style={{ fontSize: 12.5 }}>{a.recommended_action}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState icon={<HiOutlineShieldCheck />} title="No stock risks">No product is at or below its reorder point.</EmptyState>}
          </Panel>

          <Panel as="section" aria-labelledby="health-title">
            <PanelHeader title="Data health" titleId="health-title" description={versionInfo ? `Version #${versionInfo.version_number} · ${fmtNum(versionInfo.rows_added)} records added` : 'Quality of your latest import'} />
            <div className="panel-body health-body">
              {loading ? <Skeleton height={180} /> : (
                <>
                  <div className="health-top">
                    <ScoreRing value={qualityScore} size={96} label="quality" />
                    <dl className="health-list">
                      <div><dt>Freshness</dt><dd>{freshScore == null ? '—' : <StatusBadge tone={freshScore >= 70 ? 'success' : freshScore >= 40 ? 'warning' : 'critical'}>{freshScore >= 70 ? 'Fresh' : freshScore >= 40 ? 'Aging' : 'Stale'}</StatusBadge>}</dd></div>
                      <div><dt>Last upload</dt><dd className="num">{quality.last_upload ? new Date(quality.last_upload).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</dd></div>
                      <div><dt>Records</dt><dd className="num">{fmtNum(freshness?.total_records)}</dd></div>
                    </dl>
                  </div>
                  <div className="health-split">
                    {[['Clean', quality.clean_records, 'var(--success)'], ['Duplicates', quality.duplicates, 'var(--warning)'], ['Rejected', quality.rejected || 0, 'var(--critical)']].map(([l, v, tone]) => (
                      <div key={l}><span className="dot" style={{ '--tone': tone }} /><p>{l}</p><strong className="num">{fmtNum(v)}</strong></div>
                    ))}
                  </div>
                  <Button variant="secondary" href="/upload" block icon={<HiOutlineArrowUpTray />}>Upload data</Button>
                </>
              )}
            </div>
          </Panel>
        </div>

        <footer className="page-status">
          <span>Last upload <strong>{quality.last_upload ? new Date(quality.last_upload).toLocaleString() : '—'}</strong></span>
          <span>Refreshes automatically every 60 seconds</span>
        </footer>
      </div>
    </ProtectedRoute>
  );
}
