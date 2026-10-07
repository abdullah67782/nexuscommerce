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
import EmptyState from '../../components/ui/EmptyState';
import HatchDefs from '../../components/charts/HatchDefs';
import { C, axisProps, gridProps, cursorProps } from '../../components/charts/chartTheme';
import api from '../../services/api';
import { HiArrowPath, HiArrowRight, HiCheckCircle, HiMagnifyingGlass, HiCursorArrowRays } from 'react-icons/hi2';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

const STRATEGIES = {
  increase: { status: 'status-ok', label: 'Increase' },
  decrease: { status: 'status-critical', label: 'Decrease' },
  maintain: { status: 'status-info', label: 'Maintain' },
  promote: { status: 'status-warning', label: 'Promote' },
};

const MOCK_PRODUCTS = [
  { id: 1, name: 'Wireless Mouse', category: 'Electronics', currentPrice: 29.99, suggestedPrice: 34.99, margin: 42, demand: 'high', elasticity: -1.2, strategy: 'increase', reason: 'High demand & low competition — room to grow margin' },
  { id: 2, name: 'Mechanical Keyboard', category: 'Electronics', currentPrice: 89.99, suggestedPrice: 84.99, margin: 38, demand: 'medium', elasticity: -2.1, strategy: 'decrease', reason: 'Competitors underpricing by 12% — slight cut retains share' },
  { id: 3, name: 'Gaming Headset', category: 'Electronics', currentPrice: 59.99, suggestedPrice: 59.99, margin: 45, demand: 'high', elasticity: -0.8, strategy: 'maintain', reason: 'Optimal price point — elasticity favours stability' },
  { id: 4, name: 'USB-C Hub', category: 'Accessories', currentPrice: 24.99, suggestedPrice: 19.99, margin: 52, demand: 'low', elasticity: -3.4, strategy: 'promote', reason: 'Slow-moving inventory — temporary discount advised' },
  { id: 5, name: 'Desk Mat', category: 'Accessories', currentPrice: 19.99, suggestedPrice: 22.99, margin: 61, demand: 'medium', elasticity: -1.5, strategy: 'increase', reason: 'Margin well above category average — small lift safe' },
  { id: 6, name: 'Monitor Stand', category: 'Accessories', currentPrice: 44.99, suggestedPrice: 44.99, margin: 39, demand: 'high', elasticity: -1.0, strategy: 'maintain', reason: 'Stable demand — no change recommended this cycle' },
  { id: 7, name: 'Ergonomic Chair', category: 'Furniture', currentPrice: 299.99, suggestedPrice: 279.99, margin: 28, demand: 'low', elasticity: -2.8, strategy: 'decrease', reason: 'Demand softened 18% — reduce to stimulate Q3 sales' },
  { id: 8, name: 'Standing Desk', category: 'Furniture', currentPrice: 449.99, suggestedPrice: 499.99, margin: 31, demand: 'high', elasticity: -0.6, strategy: 'increase', reason: 'Premium segment — price-insensitive buyers, margin upside' },
];

const MOCK_ELASTICITY = [
  { price: 20, demand: 980 }, { price: 25, demand: 820 }, { price: 30, demand: 700 },
  { price: 35, demand: 580 }, { price: 40, demand: 460 }, { price: 45, demand: 360 },
  { price: 50, demand: 280 }, { price: 55, demand: 210 }, { price: 60, demand: 150 },
];

const fmt = v => `$${Number(v).toFixed(2)}`;
const pctDiff = (a, b) => {
  const d = ((b - a) / a) * 100;
  return { val: Math.abs(d).toFixed(1), up: d >= 0 };
};

export default function PricingPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [isSample, setIsSample] = useState(false);
  const [selected, setSelected] = useState(null);
  const tableRef = useRef(null);

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const r = await api.get('/pricing/recommendations');
      const data = r.data;
      if (Array.isArray(data) && data.length) {
        setProducts(data.map(d => ({
          id: d.product_id,
          name: d.product_name,
          category: d.category || '—',
          currentPrice: d.current_price,
          suggestedPrice: d.suggested_price,
          margin: d.margin_pct || 0,
          demand: d.demand_level?.toLowerCase() || 'medium',
          elasticity: d.price_elasticity || -1,
          strategy: d.strategy?.toLowerCase() || 'maintain',
          reason: d.reason || '',
        })));
        setIsSample(false);
      } else { setProducts(MOCK_PRODUCTS); setIsSample(true); }
    } catch { setProducts(MOCK_PRODUCTS); setIsSample(true); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = products.filter(p => {
    const matchStrat = filter === 'all' || p.strategy === filter;
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase());
    return matchStrat && matchSearch;
  });

  const counts = {
    all: products.length,
    increase: products.filter(p => p.strategy === 'increase').length,
    decrease: products.filter(p => p.strategy === 'decrease').length,
    maintain: products.filter(p => p.strategy === 'maintain').length,
    promote: products.filter(p => p.strategy === 'promote').length,
  };

  const totalRevenueDelta = products.reduce((acc, p) => acc + (p.suggestedPrice - p.currentPrice) * 100, 0);
  const avgMargin = products.length ? (products.reduce((a, p) => a + p.margin, 0) / products.length).toFixed(1) : 0;

  const showStrategy = strategy => {
    setFilter(strategy);
    setSearch('');
    requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const attention = [];
  if (counts.increase > 0) {
    attention.push({
      id: 'increase', severity: 'success',
      title: `${counts.increase} product${counts.increase > 1 ? 's have' : ' has'} room to move up`,
      why: `Low price sensitivity and strong demand. Applying all suggestions is estimated to change monthly revenue by ${totalRevenueDelta >= 0 ? '+' : '−'}${fmt(Math.abs(totalRevenueDelta))}.`,
      action: <Button size="sm" iconRight={<HiArrowRight />} onClick={() => showStrategy('increase')}>Show increases</Button>,
    });
  }
  if (counts.promote > 0) {
    attention.push({
      id: 'promote', severity: 'warning',
      title: `${counts.promote} slow-moving product${counts.promote > 1 ? 's' : ''} could use a promotion`,
      why: 'A temporary discount can help clear stock that is not selling.',
      action: <Button variant="secondary" size="sm" iconRight={<HiArrowRight />} onClick={() => showStrategy('promote')}>Show promotions</Button>,
    });
  }
  if (counts.decrease > 0) {
    attention.push({
      id: 'decrease', severity: 'info',
      title: `${counts.decrease} product${counts.decrease > 1 ? 's' : ''} may be priced too high`,
      why: 'A small reduction could protect sales where demand has softened.',
      action: <Button variant="secondary" size="sm" iconRight={<HiArrowRight />} onClick={() => showStrategy('decrease')}>Show decreases</Button>,
    });
  }

  return (
    <ProtectedRoute>
      <div className="page">
        <PageHeader title="Pricing" description="Suggested price changes for each product, and the reasoning behind them.">
          <Button variant="secondary" onClick={() => load(true)} disabled={refreshing} icon={<HiArrowPath className={refreshing ? 'spin' : ''} />}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
        </PageHeader>

        <section aria-labelledby="price-attention-title">
          <div className="group-head">
            <h2 id="price-attention-title" className="text-section">Opportunities</h2>
            {isSample && <span className="badge status-warning" title="The live endpoint returned no data, so illustrative rows are shown">Sample data</span>}
          </div>
          <Panel className="attention-panel">
            {loading ? (
              <div className="panel-body" style={{ display: 'grid', gap: 12 }}><Skeleton height={44} /><Skeleton height={44} /></div>
            ) : (
              <ul className="action-list">
                {attention.length
                  ? attention.map(item => <ActionItem key={item.id} severity={item.severity} title={item.title} why={item.why} action={item.action} />)
                  : <ActionItem severity="success" title="Prices look well placed" why="All products are priced well for current demand. Check back as new sales come in." />}
              </ul>
            )}
          </Panel>
        </section>

        <section className="figures" aria-label="Pricing summary">
          <Stat label="Revenue upside" value={`${totalRevenueDelta >= 0 ? '+' : ''}${fmt(totalRevenueDelta)}`} tone="var(--success)" loading={loading} hint="estimated monthly change" />
          <Stat label="Average margin" value={avgMargin} unit="%" tone="var(--pricing)" loading={loading} hint="across all products" />
          <Stat label="Price increases" value={counts.increase} tone="var(--data)" loading={loading} hint="recommended" />
          <Stat label="Need promotion" value={counts.promote} tone="var(--warning)" loading={loading} hint="slow-moving products" />
        </section>

        <div className="page-grid">
          <Panel className="span-8" tone="var(--pricing)" aria-labelledby="elasticity-title">
            <PanelHeader title="Price–demand curve" titleId="elasticity-title" description={selected ? `How demand may respond to price · ${selected.name}` : 'How demand may respond to price changes'}>
              {selected && (
                <div className="chart-legend">
                  <span style={{ '--tone': C.bone }}><i className="is-dash" />Current</span>
                  <span style={{ '--tone': C.pricing }}><i className="is-dash" />Suggested</span>
                </div>
              )}
              <span className="badge" title="The curve shape is illustrative; the current and suggested markers use the selected product's prices">Illustrative curve</span>
            </PanelHeader>
            <div className="panel-body">
              <div className="chart-box" style={{ height: 300 }}>
                {loading ? <Skeleton height="100%" /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={MOCK_ELASTICITY} margin={{ top: 22, right: 10, left: -16, bottom: 0 }}>
                      <HatchDefs fadeId="priceFade" fadeColor={C.pricing} />
                      <CartesianGrid {...gridProps} />
                      <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']} {...axisProps} tickFormatter={v => `$${v}`} />
                      <YAxis {...axisProps} />
                      <Tooltip content={<ChartTooltip labelFormatter={(_, entries) => `Price ${fmt(entries[0]?.payload?.price)}`} valueFormatter={value => `${value} units`} />} cursor={cursorProps} />
                      <Area type="monotone" dataKey="demand" stroke="none" fill="url(#priceFade)" legendType="none" tooltipType="none" />
                      <Line type="monotone" dataKey="demand" stroke={C.pricing} strokeWidth={2} dot={{ r: 2.5, fill: C.pricing, strokeWidth: 0 }} name="Demand" />
                      {selected && <ReferenceLine x={selected.currentPrice} stroke={C.bone} strokeOpacity={0.6} strokeDasharray="4 3" label={{ value: 'Current', fontSize: 11, fill: C.muted, position: 'top', fontFamily: 'var(--font-sans)' }} />}
                      {selected && <ReferenceLine x={selected.suggestedPrice} stroke={C.pricing} strokeDasharray="4 3" label={{ value: 'Suggested', fontSize: 11, fill: C.pricing, position: 'top', fontFamily: 'var(--font-sans)' }} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </Panel>

          <Panel className="span-4" aria-live="polite">
            <PanelHeader title={selected ? selected.name : 'Product detail'} description={selected ? selected.category : 'Select a row in the table'} />
            <div className="panel-body detail-body">
              {selected ? (() => {
                const diff = pctDiff(selected.currentPrice, selected.suggestedPrice);
                const s = STRATEGIES[selected.strategy] || STRATEGIES.maintain;
                return (
                  <>
                    <div className="detail-status">
                      <span className={`status ${s.status}`}>{s.label}</span>
                      <span className={`num ${diff.up ? 'change-up' : 'change-down'}`}>{diff.up ? '+' : '−'}{diff.val}%</span>
                    </div>
                    <div className="detail-grid">
                      <div><span>Current</span><strong className="num">{fmt(selected.currentPrice)}</strong></div>
                      <div style={{ '--tone': diff.up ? 'var(--success)' : 'var(--danger)' }}><span>Suggested</span><strong className="num">{fmt(selected.suggestedPrice)}</strong></div>
                      <div style={{ '--tone': 'var(--pricing)' }}><span>Margin</span><strong className="num">{selected.margin}%</strong></div>
                      <div><span>Price sensitivity</span><strong className="num">{selected.elasticity}</strong></div>
                    </div>
                    <p className="reason">{selected.reason}</p>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(null)} style={{ justifySelf: 'start' }}>Clear selection</Button>
                  </>
                );
              })() : (
                <EmptyState icon={<HiCursorArrowRays />} title="Pick a product">Select any row below to see the suggested price and the reasoning behind it.</EmptyState>
              )}
            </div>
          </Panel>
        </div>

        <Panel ref={tableRef} className="scroll-target" aria-labelledby="pricing-table-title">
          <PanelHeader title="Recommendations" titleId="pricing-table-title" description="Select a row to see its details">
            <Segmented
              label="Filter by strategy"
              value={filter}
              onChange={setFilter}
              options={['all', 'increase', 'decrease', 'maintain', 'promote'].map(f => ({ value: f, label: f, count: f !== 'all' ? counts[f] : undefined }))}
            />
            <div className="input-icon-wrap search-field">
              <HiMagnifyingGlass className="input-icon" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" aria-label="Search products" className="input-field input-with-icon" />
            </div>
          </PanelHeader>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>{['Product', 'Category', 'Current', 'Suggested', 'Change', 'Margin', 'Strategy', 'Reason'].map(h => <th key={h} className={['Current', 'Suggested', 'Change', 'Margin'].includes(h) ? 'is-num' : ''}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {loading ? [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={8}><Skeleton height={22} /></td></tr>
                )) : filtered.length > 0 ? filtered.map(p => {
                  const diff = pctDiff(p.currentPrice, p.suggestedPrice);
                  const s = STRATEGIES[p.strategy] || STRATEGIES.maintain;
                  const isSelected = selected?.id === p.id;
                  return (
                    <tr key={p.id} onClick={() => setSelected(isSelected ? null : p)} className={`is-clickable ${isSelected ? 'is-selected' : ''}`}>
                      <td><button type="button" className="row-button" aria-pressed={isSelected} aria-label={`View price details for ${p.name}`} onClick={event => { event.stopPropagation(); setSelected(isSelected ? null : p); }}>{p.name}</button></td>
                      <td>{p.category}</td>
                      <td className="is-num">{fmt(p.currentPrice)}</td>
                      <td className="is-num is-strong">{fmt(p.suggestedPrice)}</td>
                      <td className={`is-num ${diff.up ? 'change-up' : 'change-down'}`}>{diff.up ? '▲' : '▼'} {diff.val}%</td>
                      <td className="is-num">{p.margin}%</td>
                      <td><span className={`status ${s.status}`}>{s.label}</span></td>
                      <td className="cell-note">{p.reason}</td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={8}><EmptyState icon={<HiCheckCircle />} title="No matches">No products match this filter.</EmptyState></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </ProtectedRoute>
  );
}
