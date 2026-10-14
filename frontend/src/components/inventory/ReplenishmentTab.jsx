'use client';
// Stage 2 replenishment queue: one advisory row per product, with counts across
// all products. Nothing here orders anything; a draft can be created only from a
// provisional result inside the product's Outlook, and it still needs approval.
import { useState, useEffect, useCallback, useRef } from 'react';
import { Panel, PanelHeader } from '../ui/Panel';
import Stat from '../ui/Stat';
import Button from '../ui/Button';
import ActionItem from '../ui/ActionItem';
import Segmented from '../ui/Segmented';
import StatusBadge from '../ui/StatusBadge';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import api from '../../services/api';
import { REC_STATUS, METHOD } from './Outlook';
import { HiArrowPath, HiArrowRight, HiExclamationTriangle, HiMagnifyingGlass, HiClipboardDocumentCheck, HiCube, HiChevronLeft, HiChevronRight } from 'react-icons/hi2';

const PAGE_SIZE = 25;
const FILTERS = [
  { value: 'all', label: 'All', count: 'total' },
  { value: 'shortage_before_arrival', label: 'Short before arrival', count: 'shortage_before_arrival' },
  { value: 'order_suggested', label: 'Order suggested', count: 'order_suggested' },
  { value: 'needs_information', label: 'Needs information', count: 'needs_information' },
  { value: 'indicative', label: 'Indicative', count: 'indicative' },
];
const STOCK = { last_known: 'last known', stale: 'stale count', missing: 'no count', unverified_only: 'unverified only', inconsistent: 'inconsistent' };
const errorText = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback;
const n1 = (x) => (x == null ? '—' : Number.isInteger(x) ? x.toLocaleString() : (Math.round(x * 10) / 10).toFixed(1));

export default function ReplenishmentTab({ renderProduct }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const tableRef = useRef(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (filter !== 'all') params.set('state', filter);
      if (query) params.set('q', query);
      setData((await api.get(`/inventory/replenishment?${params}`)).data);
      setError(null);
    } catch (e) { setError(errorText(e, 'The replenishment queue could not be loaded.')); }
    finally { setLoading(false); }
  }, [page, filter, query]);
  useEffect(() => { queueMicrotask(load); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setPage(1); setQuery(search.trim()); }, 300); return () => clearTimeout(t); }, [search]);

  const c = data?.counts;
  const firstLoad = loading && !data;
  const show = (v) => { setFilter(v); setPage(1); requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const attention = [];
  if (c) {
    if (c.shortage_before_arrival) attention.push({ id: 'sba', severity: 'critical', title: `${c.shortage_before_arrival} ${c.shortage_before_arrival === 1 ? 'product is' : 'products are'} expected to run short before a new order could arrive`, why: 'A new order cannot prevent this shortage. Ask the supplier about faster delivery, or check the overdue orders.', action: <Button size="sm" iconRight={<HiArrowRight />} onClick={() => show('shortage_before_arrival')}>Show</Button> });
    if (c.order_suggested) attention.push({ id: 'ord', severity: 'warning', title: `${c.order_suggested} ${c.order_suggested === 1 ? 'product has' : 'products have'} a provisional order suggestion`, why: 'Based on last-known stock and the forecast totals. Review each one; a draft still needs your approval.', action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('order_suggested')}>Show</Button> });
    if (c.needs_information) attention.push({ id: 'ni', severity: 'info', title: `${c.needs_information} ${c.needs_information === 1 ? 'product needs' : 'products need'} information before a quantity can be given`, why: 'A count, a supplier, a lead time or confirmed sales history is missing.', action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('needs_information')}>Show</Button> });
    if (c.indicative) attention.push({ id: 'ind', severity: 'info', title: `${c.indicative} ${c.indicative === 1 ? 'result is' : 'results are'} indicative only`, why: 'A stale count, a forecast that started before today, or forecasts that disagree. No draft button until resolved.', action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('indicative')}>Show</Button> });
    if (c.unavailable) attention.unshift({ id: 'down', severity: 'critical', title: `No outlook for ${c.unavailable} ${c.unavailable === 1 ? 'product' : 'products'}: the forecast service is unavailable`, why: 'Shortages and order quantities cannot be worked out without the forecast. Nothing older is shown instead. Try again once the service is running.', action: <Button size="sm" variant="secondary" icon={<HiArrowPath />} onClick={load}>Retry</Button> });
    if (!attention.length && c.total) attention.push({ id: 'ok', severity: 'success', title: 'Nothing needs ordering now', why: 'Every product with enough information is covered through its review window.' });
  }

  return (
    <>
      <div className="stack">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="side-note">{data ? `Planning date ${data.planning_date} (${data.timezone}) · ${data.engine_version} · advisory only — nothing is ordered automatically.` : ' '}</span>
          <Button variant="secondary" onClick={load} disabled={loading} icon={<HiArrowPath className={loading ? 'spin' : ''} />}>{loading ? 'Computing…' : 'Recompute'}</Button>
        </div>
        {data?.forecast_service === 'unavailable' && (
          <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}><HiExclamationTriangle style={{ verticalAlign: '-2px' }} /> The forecast service is unavailable for {c.unavailable} product(s){data.forecast_service_message ? ` (${data.forecast_service_message})` : ''}. Their demand figures are not shown.</p>
        )}
        {error && !data ? (
          <Panel><EmptyState icon={<HiExclamationTriangle />} title="Replenishment could not be loaded" action={<Button variant="secondary" onClick={load} icon={<HiArrowPath />}>Retry</Button>}>{error} No figures are shown rather than sample ones.</EmptyState></Panel>
        ) : c && c.total === 0 ? (
          <Panel><EmptyState icon={<HiCube />} title="No products yet" action={<Button href="/upload" iconRight={<HiArrowRight />}>Go to Data Integration</Button>}>Products come from your sales imports.</EmptyState></Panel>
        ) : (
          <>
            {error && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{error} Showing the last result that loaded.</p>}
            <section aria-labelledby="rep-attention-title">
              <div className="group-head"><h2 id="rep-attention-title" className="text-section">Needs your attention</h2></div>
              <Panel className="attention-panel">
                {firstLoad ? <div className="panel-body" style={{ display: 'grid', gap: 12 }}><Skeleton height={44} /><Skeleton height={44} /></div>
                  : <ul className="action-list">{attention.map(a => <ActionItem key={a.id} severity={a.severity} title={a.title} why={a.why} action={a.action} />)}</ul>}
              </Panel>
            </section>
            <section className="figures" aria-label="Replenishment summary">
              <Stat label="Short before arrival" value={c && n1(c.shortage_before_arrival)} tone="var(--danger)" loading={firstLoad} hint="cannot be prevented by a new order" />
              <Stat label="Order suggested" value={c && n1(c.order_suggested)} tone="var(--inventory)" loading={firstLoad} hint="provisional, needs your review" />
              <Stat label="Needs information" value={c && n1(c.needs_information)} tone="var(--warning)" loading={firstLoad} hint="no quantity yet" />
              <Stat label="Indicative only" value={c && n1(c.indicative)} tone="var(--warning)" loading={firstLoad} hint="not actionable" />
            </section>
            <Panel ref={tableRef} className="scroll-target" aria-labelledby="rep-table-title">
              <PanelHeader title="Replenishment" titleId="rep-table-title" description="Last-known stock against the forecast totals, deliveries usable the day after they are due. Quantities are suggestions, not orders.">
                <Segmented label="Filter" value={filter} onChange={(v) => { setFilter(v); setPage(1); }}
                  options={FILTERS.map(f => ({ value: f.value, label: f.label, count: c ? c[f.count] : undefined }))} />
                <div className="input-icon-wrap search-field">
                  <HiMagnifyingGlass className="input-icon" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" aria-label="Search products" className="input-field input-with-icon" />
                </div>
              </PanelHeader>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr>{['Product', 'Status', 'Short within 7 / 28 days', 'Short before arrival', 'Suggested', 'Stock', 'Forecast', 'Next step'].map(h =>
                    <th key={h} className={['Short within 7 / 28 days', 'Short before arrival', 'Suggested'].includes(h) ? 'is-num' : ''}>{h}</th>)}</tr></thead>
                  <tbody>
                    {firstLoad ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={8}><Skeleton height={22} /></td></tr>)
                      : data.items.length ? data.items.map(it => <Row key={it.product.id} it={it} onOpen={() => setOpenId(it.product.id)} />)
                        : <tr><td colSpan={8}><EmptyState icon={<HiClipboardDocumentCheck />} title="No matches">No product matches this filter.</EmptyState></td></tr>}
                  </tbody>
                </table>
              </div>
              {data && data.total > PAGE_SIZE && (
                <div className="panel-foot">
                  <span className="side-note">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <Button variant="secondary" size="sm" icon={<HiChevronLeft />} disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}>Previous</Button>
                    <Button variant="secondary" size="sm" iconRight={<HiChevronRight />} disabled={page * PAGE_SIZE >= data.total || loading} onClick={() => setPage(p => p + 1)}>Next</Button>
                  </span>
                </div>
              )}
              <div className="panel-foot panel-foot-start"><span className="side-note">Assumptions: totals spread evenly inside the 7- and 28-day blocks (A1); deliveries usable the day after their expected date (A2); unmet demand is lost (A3); today counts as a full day (A4). Overdue, undated, approved-not-sent and draft orders are never counted as incoming.</span></div>
            </Panel>
          </>
        )}
      </div>
      {openId && renderProduct(openId, () => setOpenId(null), load)}
    </>
  );
}

function Row({ it, onOpen }) {
  const st = REC_STATUS[it.status] || REC_STATUS.needs_information;
  const f = it.forecast;
  return (
    <tr className="is-clickable" onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} tabIndex={0} aria-label={`Open the outlook for ${it.product.name}`}>
      <td className="is-strong">{it.product.name}<span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>{it.product.category || '—'}</span></td>
      <td><StatusBadge tone={st.tone}>{st.label}</StatusBadge></td>
      <td className="is-num">{it.shortage_7_units == null ? <span className="text-faint">—</span>
        : <span style={{ color: it.shortage_within_7 ? 'var(--danger)' : undefined }}>{n1(it.shortage_7_units)} / {n1(it.shortage_28_units)}</span>}
        {it.covered_days_28 != null && it.covered_days_28 < 28 && <span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>{it.covered_days_28} days covered</span>}</td>
      <td className="is-num">{it.before_arrival_shortage == null ? <span className="text-faint">—</span>
        : <span style={{ color: it.before_arrival_shortage > 0 ? 'var(--danger)' : undefined, fontWeight: it.before_arrival_shortage > 0 ? 600 : undefined }}>{n1(it.before_arrival_shortage)}</span>}</td>
      <td className="is-num">{it.suggested_quantity == null ? <span className="text-faint">—</span>
        : <span className="num" style={{ fontWeight: it.actionable ? 600 : 400, color: it.suggestion_indicative ? 'var(--text-3)' : undefined }}>{it.suggested_quantity.toLocaleString()}</span>}
        {it.suggestion_indicative && <span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>indicative</span>}</td>
      <td className="cell-note">{it.stock.on_hand == null ? STOCK[it.stock.state] || it.stock.state : <>{it.stock.on_hand.toLocaleString()}<span className="list-row-aside" style={{ display: 'block' }}>{STOCK[it.stock.state]}{it.stock.count_age_days != null ? ` · ${it.stock.count_age_days} d old` : ''}</span></>}</td>
      <td className="cell-note">{!f || f.status !== 'ok' ? (f?.status === 'unavailable' ? 'unavailable' : 'no forecast') : <>{METHOD[f.method] || f.method}<span className="list-row-aside" style={{ display: 'block' }}>{f.lag_days == null ? 'different timezone' : f.lag_days === 0 ? 'starts today' : f.lag_days > 0 ? `${f.lag_days} d behind` : 'starts tomorrow'}</span></>}</td>
      <td className="cell-note">{it.next_step}</td>
    </tr>
  );
}
