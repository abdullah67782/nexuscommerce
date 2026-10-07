'use client';
import { useState, useEffect, useRef } from 'react';
import ProtectedRoute from '../../components/ProtectedRoute';
import PageHeader from '../../components/PageHeader';
import ChartTooltip from '../../components/ChartTooltip';
import { Panel, PanelHeader } from '../../components/ui/Panel';
import Stat from '../../components/ui/Stat';
import Button from '../../components/ui/Button';
import ActionItem from '../../components/ui/ActionItem';
import Skeleton from '../../components/ui/Skeleton';
import Segmented from '../../components/ui/Segmented';
import Meter from '../../components/ui/Meter';
import EmptyState from '../../components/ui/EmptyState';
import { C, axisProps, gridProps } from '../../components/charts/chartTheme';
import api from '../../services/api';
import { HiArrowPath, HiShieldCheck, HiMagnifyingGlass, HiArrowRight } from 'react-icons/hi2';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const RISK = {
  critical: { status: 'status-critical', color: C.danger },
  high: { status: 'status-high', color: C.warning },
  medium: { status: 'status-medium', color: C.data },
  low: { status: 'status-low', color: C.inventory },
};

const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const MOCK_PRODUCTS = [
  { id: 1, name: 'Wireless Mouse', stock: 12, threshold: 20, category: 'Electronics', risk: 'critical', action: 'Reorder immediately — only 12 units left', trend: 'down' },
  { id: 2, name: 'Mechanical Keyboard', stock: 8, threshold: 15, category: 'Electronics', risk: 'critical', action: 'Stock critically low — place order today', trend: 'down' },
  { id: 3, name: 'Gaming Headset', stock: 25, threshold: 20, category: 'Electronics', risk: 'high', action: 'Approaching reorder threshold', trend: 'down' },
  { id: 4, name: 'USB-C Hub', stock: 55, threshold: 30, category: 'Accessories', risk: 'low', action: 'Stock levels healthy', trend: 'up' },
  { id: 5, name: 'Desk Mat', stock: 18, threshold: 25, category: 'Accessories', risk: 'high', action: 'Below threshold — schedule reorder this week', trend: 'down' },
  { id: 6, name: 'Monitor Stand', stock: 42, threshold: 15, category: 'Accessories', risk: 'low', action: 'Stock healthy — no action needed', trend: 'up' },
  { id: 7, name: 'Ergonomic Chair', stock: 6, threshold: 10, category: 'Furniture', risk: 'critical', action: 'Urgent: only 6 units left, reorder point exceeded', trend: 'down' },
  { id: 8, name: 'Standing Desk', stock: 15, threshold: 10, category: 'Furniture', risk: 'medium', action: 'Monitor closely — nearing threshold', trend: 'down' },
];

export default function InventoryPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [isSample, setIsSample] = useState(false);
  const tableRef = useRef(null);

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const r = await api.get('/inventory/alerts');
      const data = r.data;
      if (Array.isArray(data) && data.length) {
        setProducts(data.map(d => ({
          id: d.product_id, name: d.product_name, stock: d.stock_level,
          threshold: d.reorder_threshold || 20, category: d.category || '—',
          risk: d.risk_level?.toLowerCase() || 'low', action: d.recommended_action || '',
          trend: d.stock_level < (d.reorder_threshold || 20) ? 'down' : 'up',
        })));
        setIsSample(false);
      } else { setProducts(MOCK_PRODUCTS); setIsSample(true); }
    } catch { setProducts(MOCK_PRODUCTS); setIsSample(true); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = products.filter(p => {
    const matchRisk = filter === 'all' || p.risk === filter;
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
    return matchRisk && matchSearch;
  });

  const counts = {
    all: products.length,
    critical: products.filter(p => p.risk === 'critical').length,
    high: products.filter(p => p.risk === 'high').length,
    medium: products.filter(p => p.risk === 'medium').length,
    low: products.filter(p => p.risk === 'low').length,
  };

  const chartData = products.map(p => ({
    name: p.name.split(' ').slice(0, 2).join(' '),
    stock: p.stock, threshold: p.threshold,
    tone: (RISK[p.risk] || RISK.low).color,
  }));

  // Tilt axis labels only when there are enough products to crowd them.
  const tiltLabels = chartData.length > 6;

  const showRisk = risk => {
    setFilter(risk);
    setSearch('');
    requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // Most urgent first: risk level, then how far below the reorder point.
  const sorted = [...filtered].sort((a, b) =>
    (RANK[a.risk] ?? 9) - (RANK[b.risk] ?? 9) || (a.stock / Math.max(a.threshold, 1)) - (b.stock / Math.max(b.threshold, 1)));

  const attention = [];
  if (counts.critical > 0) {
    attention.push({
      id: 'critical', severity: 'critical',
      title: `${counts.critical} product${counts.critical > 1 ? 's need' : ' needs'} reordering now`,
      why: 'Stock is at or below the reorder point. Reordering now keeps these products from selling out.',
      action: <Button size="sm" iconRight={<HiArrowRight />} onClick={() => showRisk('critical')}>Show critical</Button>,
    });
  }
  if (counts.high > 0) {
    attention.push({
      id: 'high', severity: 'warning',
      title: `${counts.high} product${counts.high > 1 ? 's are' : ' is'} running low`,
      why: 'Schedule a reorder this week to stay ahead of demand.',
      action: <Button variant="secondary" size="sm" iconRight={<HiArrowRight />} onClick={() => showRisk('high')}>Show high risk</Button>,
    });
  }

  return (
    <ProtectedRoute>
      <div className="page">
        <PageHeader title="Inventory" description="Stock levels against their reorder points, with the most urgent products first.">
          <Button variant="secondary" onClick={() => load(true)} disabled={refreshing} icon={<HiArrowPath className={refreshing ? 'spin' : ''} />}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
        </PageHeader>

        <section aria-labelledby="inv-attention-title">
          <div className="group-head">
            <h2 id="inv-attention-title" className="text-section">Needs your attention</h2>
            {isSample && <span className="badge status-warning" title="The live endpoint returned no data, so illustrative rows are shown">Sample data</span>}
          </div>
          <Panel className="attention-panel">
            {loading ? (
              <div className="panel-body" style={{ display: 'grid', gap: 12 }}><Skeleton height={44} /><Skeleton height={44} /></div>
            ) : attention.length ? (
              <ul className="action-list">
                {attention.map(item => <ActionItem key={item.id} severity={item.severity} title={item.title} why={item.why} action={item.action} />)}
              </ul>
            ) : (
              <ul className="action-list">
                <ActionItem severity="success" title="Critical products are covered" why="All critical products are sufficiently stocked. Check back as new sales come in." />
              </ul>
            )}
          </Panel>
        </section>

        <section className="figures" aria-label="Stock risk summary">
          <Stat label="Critical" value={counts.critical} tone="var(--danger)" loading={loading} hint="products in this state" />
          <Stat label="High risk" value={counts.high} tone="var(--warning)" loading={loading} hint="products in this state" />
          <Stat label="Medium" value={counts.medium} tone="var(--data)" loading={loading} hint="products in this state" />
          <Stat label="Healthy" value={counts.low} tone="var(--inventory)" loading={loading} hint="products in this state" />
        </section>

        <Panel ref={tableRef} className="scroll-target" aria-labelledby="stock-table-title">
          <PanelHeader title="Products" titleId="stock-table-title" description="Sorted by urgency">
            <Segmented
              label="Filter by risk"
              value={filter}
              onChange={setFilter}
              options={['all', 'critical', 'high', 'medium', 'low'].map(f => ({ value: f, label: f, count: f !== 'all' ? counts[f] : undefined }))}
            />
            <div className="input-icon-wrap search-field">
              <HiMagnifyingGlass className="input-icon" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" aria-label="Search products" className="input-field input-with-icon" />
            </div>
          </PanelHeader>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>{['Product', 'Category', 'Stock', 'Reorder point', 'Status', 'Next step'].map(h => <th key={h} className={h === 'Reorder point' ? 'is-num' : ''}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {loading ? [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={6}><Skeleton height={22} /></td></tr>
                )) : sorted.length > 0 ? sorted.map(p => {
                  const r = RISK[p.risk] || RISK.low;
                  return (
                    <tr key={p.id}>
                      <td className="is-strong">{p.name}</td>
                      <td>{p.category}</td>
                      <td style={{ minWidth: 160 }}>
                        <div className="stock-cell-inline">
                          <span className="num" style={{ color: p.stock <= p.threshold ? 'var(--danger)' : 'var(--foreground)' }}>{p.stock}</span>
                          <Meter value={p.stock} max={Math.max(p.threshold, 1)} tone={r.color} label={`${p.name} stock against threshold`} />
                        </div>
                      </td>
                      <td className="is-num">{p.threshold}</td>
                      <td><span className={`status is-cap ${r.status}`}>{p.risk}</span></td>
                      <td className="cell-note">{p.action}</td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={6}><EmptyState icon={<HiShieldCheck />} title="No matches">No products match this filter.</EmptyState></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel tone="var(--inventory)" aria-labelledby="stock-chart-title">
          <PanelHeader title="Stock against reorder point" titleId="stock-chart-title" description="Coloured bars show current stock by risk; grey bars mark each reorder point">
            <div className="chart-legend">
              <span style={{ '--tone': C.danger }}><i />Critical</span>
              <span style={{ '--tone': C.warning }}><i />High</span>
              <span style={{ '--tone': C.data }}><i />Medium</span>
              <span style={{ '--tone': C.inventory }}><i />Healthy</span>
              <span style={{ '--tone': '#5b544b' }}><i />Reorder point</span>
            </div>
          </PanelHeader>
          <div className="panel-body">
            <div className="chart-box" style={{ height: 260 }}>
              {loading ? <Skeleton height="100%" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 8, right: 8, left: -18, bottom: tiltLabels ? 40 : 4 }} barGap={3} barCategoryGap="28%">
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="name" {...axisProps} angle={tiltLabels ? -28 : 0} textAnchor={tiltLabels ? 'end' : 'middle'} interval={0} dy={tiltLabels ? 0 : 6} />
                    <YAxis {...axisProps} />
                    <Tooltip content={<ChartTooltip valueFormatter={value => `${value} units`} />} cursor={{ fill: '#eee7db08' }} />
                    <Bar dataKey="stock" name="Current stock" maxBarSize={22} radius={[2, 2, 0, 0]}>
                      {chartData.map((d, i) => <Cell key={i} fill={d.tone} />)}
                    </Bar>
                    <Bar dataKey="threshold" name="Reorder point" fill="#5b544b" maxBarSize={22} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </ProtectedRoute>
  );
}
