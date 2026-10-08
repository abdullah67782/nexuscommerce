'use client';
// Inventory (Stage 1a): physical stock from counts and recorded movements.
// No sample data: loading, error and empty states are real. Unknown stock is
// shown as "no count", never as zero. On-hand is physical stock at the location,
// not stock available to sell (reservations are not tracked yet).
import { useState, useEffect, useCallback, useRef } from 'react';
import ProtectedRoute from '../../components/ProtectedRoute';
import PageHeader from '../../components/PageHeader';
import Dialog from '../../components/Dialog';
import { Panel, PanelHeader } from '../../components/ui/Panel';
import Stat from '../../components/ui/Stat';
import Button from '../../components/ui/Button';
import ActionItem from '../../components/ui/ActionItem';
import Skeleton from '../../components/ui/Skeleton';
import Segmented from '../../components/ui/Segmented';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';
import api from '../../services/api';
import toast from 'react-hot-toast';
import {
  HiArrowPath, HiMagnifyingGlass, HiArrowRight, HiArrowUpTray, HiCog6Tooth, HiClipboardDocumentCheck,
  HiExclamationTriangle, HiCube, HiChevronLeft, HiChevronRight,
} from 'react-icons/hi2';

const PAGE_SIZE = 25;
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unknown_stock', label: 'No count', count: 'unknown_stock' },
  { value: 'stale', label: 'Stale', count: 'stale' },
  { value: 'below_threshold', label: 'Below threshold', count: 'below_threshold' },
  { value: 'needs_review', label: 'Needs review', count: 'needs_review' },
  { value: 'inconsistent', label: 'Inconsistent', count: 'inconsistent' },
];
const STOCK_STATE = {
  missing: { tone: 'neutral', label: 'No count' },
  unverified_only: { tone: 'warning', label: 'Unverified only' },
  inconsistent: { tone: 'critical', label: 'Inconsistent' },
  stale: { tone: 'warning', label: 'Stale count' },
  last_known: { tone: 'info', label: 'Last known' },
  tracked: { tone: 'success', label: 'Tracked' },
};
const ALERT = {
  below: { tone: 'critical', label: 'Below threshold' },
  at: { tone: 'warning', label: 'At threshold' },
  above: { tone: 'success', label: 'Above threshold' },
  not_set: { tone: 'neutral', label: 'No threshold' },
  unknown_stock: { tone: 'neutral', label: 'Stock unknown' },
};
const KINDS = {
  shipment: 'Shipment', customer_return: 'Customer return', damage: 'Damaged / lost', found: 'Found', correction: 'Correction',
};
const RELATION = {
  after_count: 'after the count — applied', at_count_included: 'at the count time — inside the count',
  before_count_included: 'before the count — inside the count', no_count: 'no count to apply to',
};
const SOURCE_KIND = { manual_count: 'Count form', count_file: 'Count file', connector: 'Connected source', legacy_migration: 'Old stock column' };

const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
// Age of a count from its own instant (not calendar days): "15 h ago", "3 days ago".
const ageText = (iso) => {
  if (!iso) return '';
  const h = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3600000));
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
// <input type="datetime-local"> value for now, in the browser's timezone.
const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toInstant = (local) => (local ? new Date(local).toISOString() : null);
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'your local time'; } };
const errorText = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback;

export default function InventoryPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const [dialog, setDialog] = useState(null); // 'file' | 'settings'
  const tableRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (filter !== 'all') params.set('state', filter);
      if (query) params.set('q', query);
      const r = await api.get(`/inventory/items?${params}`);
      setData(r.data);
      setError(null);
    } catch (e) {
      setError(errorText(e, 'The inventory could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [page, filter, query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setPage(1); setQuery(search.trim()); }, 300); return () => clearTimeout(t); }, [search]);

  const counts = data?.counts;
  const show = (value) => { setFilter(value); setPage(1); requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const firstLoad = loading && !data;
  const noProducts = counts && counts.products === 0;

  const attention = [];
  if (counts) {
    const recount = counts.stale + counts.inconsistent;
    if (counts.inconsistent) attention.push({ id: 'inc', severity: 'critical', title: `${counts.inconsistent} ${counts.inconsistent === 1 ? 'product has' : 'products have'} stock below zero after recorded movements`, why: 'A movement is missing or wrong, or the last count was. Recount these products.', action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('inconsistent')}>Show</Button> });
    if (counts.below_threshold) attention.push({ id: 'below', severity: 'critical', title: `${counts.below_threshold} counted ${counts.below_threshold === 1 ? 'product is' : 'products are'} below the reorder threshold`, why: 'Based on the last count and the movements recorded since. Check the position type before ordering.', action: <Button size="sm" iconRight={<HiArrowRight />} onClick={() => show('below_threshold')}>Show</Button> });
    if (counts.unknown_stock) attention.push({ id: 'unknown', severity: 'warning', title: `${counts.unknown_stock} ${counts.unknown_stock === 1 ? 'product has' : 'products have'} no verified count`, why: 'Their stock is unknown, not zero. Values from the old stock column are shown but have no count time, so they are not used.', action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('unknown_stock')}>Show</Button> });
    if (counts.stale) attention.push({ id: 'stale', severity: 'warning', title: `${counts.stale} ${counts.stale === 1 ? 'count is' : 'counts are'} older than your tolerance`, why: `Counts older than ${data.seller_default.stale_after_days} days need repeating. The tolerance is not evidence that stock stays accurate that long.`, action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('stale')}>Show</Button> });
    if (counts.needs_review) attention.push({ id: 'review', severity: 'info', title: `${counts.needs_review} ${counts.needs_review === 1 ? 'product needs' : 'products need'} reconciliation`, why: 'Some movements cannot be placed relative to a count (same timestamp from another source, or no count yet).', action: <Button size="sm" variant="secondary" iconRight={<HiArrowRight />} onClick={() => show('needs_review')}>Show</Button> });
    if (!recount && !attention.length && counts.products) attention.push({ id: 'ok', severity: 'success', title: 'Every product has a recent count', why: 'No counted product is below its threshold.' });
  }

  return (
    <ProtectedRoute>
      <div className="page">
        <PageHeader title="Inventory" description="Physical stock from your counts and the movements recorded since. Sales uploads never change stock.">
          <Button variant="secondary" onClick={load} disabled={loading} icon={<HiArrowPath className={loading ? 'spin' : ''} />}>{loading ? 'Loading…' : 'Refresh'}</Button>
          <Button variant="secondary" onClick={() => setDialog('settings')} disabled={!data} icon={<HiCog6Tooth />}>Settings</Button>
          <Button onClick={() => setDialog('file')} disabled={!data || noProducts} icon={<HiArrowUpTray />}>Stock count file</Button>
        </PageHeader>

        {error && !data ? (
          <Panel>
            <EmptyState icon={<HiExclamationTriangle />} title="Inventory could not be loaded" action={<Button variant="secondary" onClick={load} icon={<HiArrowPath />}>Retry</Button>}>
              {error} No figures are shown rather than sample ones.
            </EmptyState>
          </Panel>
        ) : noProducts ? (
          <Panel>
            <EmptyState icon={<HiCube />} title="No products yet" action={<Button href="/upload" iconRight={<HiArrowRight />}>Go to Data Integration</Button>}>
              Products come from your sales imports. Once they exist, record stock here with the count form or a stock-count file.
            </EmptyState>
          </Panel>
        ) : (
          <>
            {error && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{error} Showing the last figures that loaded.</p>}
            <section aria-labelledby="inv-attention-title">
              <div className="group-head"><h2 id="inv-attention-title" className="text-section">Needs your attention</h2></div>
              <Panel className="attention-panel">
                {firstLoad ? (
                  <div className="panel-body" style={{ display: 'grid', gap: 12 }}><Skeleton height={44} /><Skeleton height={44} /></div>
                ) : (
                  <ul className="action-list">{attention.map(a => <ActionItem key={a.id} severity={a.severity} title={a.title} why={a.why} action={a.action} />)}</ul>
                )}
              </Panel>
            </section>

            <section className="figures" aria-label="Stock summary">
              <Stat label="Counted" value={counts ? fmtNum(counts.products - counts.unknown_stock) : null} unit={counts ? `of ${fmtNum(counts.products)}` : undefined} tone="var(--inventory)" loading={firstLoad} hint="products with a verified count" />
              <Stat label="No count" value={counts && fmtNum(counts.unknown_stock)} tone="var(--warning)" loading={firstLoad} hint="stock unknown, not zero" />
              <Stat label="Need a recount" value={counts && fmtNum(counts.stale + counts.inconsistent)} tone="var(--warning)" loading={firstLoad} hint="stale or below zero" />
              <Stat label="Below threshold" value={counts && fmtNum(counts.below_threshold)} tone="var(--danger)" loading={firstLoad} hint="counted products" />
            </section>

            <Panel ref={tableRef} className="scroll-target" aria-labelledby="stock-table-title">
              <PanelHeader title="Products" titleId="stock-table-title" description="On hand = last verified count + movements recorded after it. Physical stock, not stock available to sell.">
                <Segmented label="Filter" value={filter} onChange={(v) => { setFilter(v); setPage(1); }}
                  options={FILTERS.map(f => ({ value: f.value, label: f.label, count: f.count && counts ? counts[f.count] : undefined }))} />
                <div className="input-icon-wrap search-field">
                  <HiMagnifyingGlass className="input-icon" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" aria-label="Search products" className="input-field input-with-icon" />
                </div>
              </PanelHeader>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>{['Product', 'On hand', 'Last count', 'Since the count', 'Reorder threshold', 'Stock status', 'Next step'].map(h => <th key={h} className={['On hand', 'Reorder threshold'].includes(h) ? 'is-num' : ''}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {firstLoad ? [...Array(5)].map((_, i) => <tr key={i}><td colSpan={7}><Skeleton height={22} /></td></tr>)
                      : data.items.length ? data.items.map(it => <ItemRow key={it.product_id} it={it} onOpen={() => setOpenId(it.product_id)} />)
                      : <tr><td colSpan={7}><EmptyState icon={<HiClipboardDocumentCheck />} title="No matches">No product matches this filter.</EmptyState></td></tr>}
                  </tbody>
                </table>
              </div>
              {data && data.total > PAGE_SIZE && (
                <div className="panel-foot">
                  <span className="side-note">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {fmtNum(data.total)}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <Button variant="secondary" size="sm" icon={<HiChevronLeft />} disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}>Previous</Button>
                    <Button variant="secondary" size="sm" iconRight={<HiChevronRight />} disabled={page * PAGE_SIZE >= data.total || loading} onClick={() => setPage(p => p + 1)}>Next</Button>
                  </span>
                </div>
              )}
              {data && <div className="panel-foot panel-foot-start"><span className="side-note">{data.notes?.join(' ')} Location: {data.location.name} ({data.location.timezone}).</span></div>}
            </Panel>
          </>
        )}
      </div>

      {openId && <ProductDialog key={openId} productId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
      {dialog === 'file' && <CountFileDialog onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} onDone={load} />}
    </ProtectedRoute>
  );
}

function OnHand({ stock }) {
  if (stock.known) {
    return <span className="num" style={{ fontWeight: 600, color: stock.on_hand < 0 ? 'var(--danger)' : 'var(--text)' }}>{fmtNum(stock.on_hand)}</span>;
  }
  return (
    <span>
      <span className="text-faint">— no count</span>
      {stock.legacy && <span className="list-row-aside" style={{ display: 'block', fontSize: 12 }} title="From the old stock column: no count time, so it is not used">old value {fmtNum(stock.legacy.quantity)}, unverified</span>}
    </span>
  );
}

function ItemRow({ it, onOpen }) {
  const st = STOCK_STATE[it.readiness.stock.state] || STOCK_STATE.missing;
  const al = ALERT[it.threshold_alert] || ALERT.not_set;
  const s = it.stock;
  return (
    <tr className="is-clickable" onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} tabIndex={0} aria-label={`Open ${it.name}`}>
      <td className="is-strong">{it.name}<span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>{it.category || '—'}</span></td>
      <td className="is-num"><OnHand stock={s} /></td>
      <td>{s.last_count ? <>{fmtWhen(s.last_count.observed_at)}<span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>{ageText(s.last_count.observed_at)} · {SOURCE_KIND[s.last_count.source_kind] || s.last_count.source_kind}</span></> : <span className="text-faint">—</span>}</td>
      <td className="cell-note">{s.known
        ? <>{s.events_since_count ? `${s.events_since_count} movement${s.events_since_count === 1 ? '' : 's'}, net ${s.net_change_since_count > 0 ? '+' : ''}${s.net_change_since_count}` : 'No movements recorded'}
            <span className="list-row-aside" style={{ display: 'block' }}>{s.movement_tracking === 'complete' ? 'every shipment is recorded' : s.movement_tracking === 'partial' ? 'some sales have no shipment record' : 'no shipment feed'}</span></>
        : s.events_without_count ? `${s.events_without_count} movement(s) waiting for a count` : '—'}</td>
      <td className="is-num">{it.policy.reorder_threshold == null ? <span className="text-faint">not set</span> : fmtNum(it.policy.reorder_threshold)}
        {it.policy.reorder_threshold != null && <span style={{ display: 'block', marginTop: 4 }}><StatusBadge tone={al.tone}>{al.label}</StatusBadge></span>}</td>
      <td><StatusBadge tone={st.tone}>{st.label}</StatusBadge></td>
      <td className="cell-note">{it.readiness.stock.action || it.readiness.reconciliation.action || '—'}</td>
    </tr>
  );
}

// ── Product drawer ───────────────────────────────────────────────────────────
function ProductDialog({ productId, onClose, onChanged }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('count');
  const load = useCallback(async () => {
    try { setItem((await api.get(`/inventory/items/${productId}`)).data); setError(null); }
    catch (e) { setError(errorText(e, 'This product could not be loaded.')); }
  }, [productId]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); onChanged(); };

  const s = item?.stock;
  const st = item ? STOCK_STATE[item.readiness.stock.state] || STOCK_STATE.missing : null;
  return (
    <Dialog onClose={onClose} labelledBy="inv-product-title" wide>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
        <div>
          <p className="dialog-kicker" style={{ color: 'var(--inventory)' }}>{item?.category || 'Product'}</p>
          <h2 id="inv-product-title" className="dialog-title" style={{ marginTop: 8 }}>{item?.name || 'Loading…'}</h2>
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      {error && !item && (
        <EmptyState icon={<HiExclamationTriangle />} title="Could not load" action={<Button variant="secondary" size="sm" onClick={load}>Retry</Button>}>{error}</EmptyState>
      )}
      {!item && !error && <div style={{ marginTop: 16 }}><Skeleton height={160} /></div>}
      {item && (
        <div className="detail-body" style={{ marginTop: 16 }}>
          <div className="detail-grid">
            <div><span>On hand (physical)</span><strong>{s.known ? fmtNum(s.on_hand) : '—'}</strong><em className="side-note" style={{ fontStyle: 'normal' }}>{s.known ? (s.position_type === 'tracked' ? 'tracked position' : 'last-known position') : 'no verified count'}</em></div>
            <div><span>Last count</span><strong style={{ fontSize: 16 }}>{s.last_count ? `${fmtNum(s.last_count.quantity)} · ${ageText(s.last_count.observed_at)}` : '—'}</strong><em className="side-note" style={{ fontStyle: 'normal' }}>{s.last_count ? fmtWhen(s.last_count.observed_at) : 'record a count below'}</em></div>
            <div><span>Since the count</span><strong style={{ fontSize: 16 }}>{s.known ? `${s.net_change_since_count > 0 ? '+' : ''}${s.net_change_since_count} (${plural(s.events_since_count, 'event')})` : '—'}</strong><em className="side-note" style={{ fontStyle: 'normal' }}>movement tracking: {s.movement_tracking.replace('_', ' ')}</em></div>
            <div><span>Stock status</span><div style={{ marginTop: 8 }}><StatusBadge tone={st.tone}>{st.label}</StatusBadge></div><em className="side-note" style={{ fontStyle: 'normal' }}>available to sell: not tracked</em></div>
          </div>
          <p className="side-note">{item.readiness.stock.reason}{item.readiness.reconciliation.state === 'needs_review' ? ` ${item.readiness.reconciliation.reason}` : ''}
            {item.readiness.sales_history ? ` Sales history: ${item.readiness.sales_history.reason}` : ''}</p>
          {s.legacy && <p className="side-note"><HiExclamationTriangle style={{ color: 'var(--warning)', verticalAlign: '-2px' }} /> Old stock column value: {fmtNum(s.legacy.quantity)}{s.legacy.written_at_server_time ? ` (written ${s.legacy.written_at_server_time}, server clock)` : ''}. It has no count time, so it is shown for reference only.</p>}
          <Segmented label="Action" value={tab} onChange={setTab} fill
            options={[{ value: 'count', label: 'Record count' }, { value: 'adjust', label: 'Adjustment' }, { value: 'policy', label: 'Threshold' }, { value: 'history', label: 'History' }]} />
          {tab === 'count' && <CountForm item={item} onDone={changed} />}
          {tab === 'adjust' && <AdjustForm item={item} onDone={changed} />}
          {tab === 'policy' && <PolicyForm item={item} onDone={changed} />}
          {tab === 'history' && <History item={item} onDone={changed} />}
        </div>
      )}
    </Dialog>
  );
}

function CountForm({ item, onDone }) {
  const [qty, setQty] = useState('');
  const [when, setWhen] = useState(localNow);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [conflict, setConflict] = useState(null);
  const key = useRef(newKey());
  const submit = async (supersede = false) => {
    setBusy(true); setErr(null);
    if (supersede) key.current = newKey();
    try {
      const r = await api.post('/inventory/snapshots', { idempotency_key: key.current, observed_at: toInstant(when), supersede,
        items: [{ product_id: item.product_id, quantity: qty === '' ? null : Number(qty) }] });
      toast.success(r.data.already_recorded ? 'That count was already recorded' : r.data.superseded ? 'Count replaced' : 'Count recorded');
      setConflict(null); setQty(''); key.current = newKey(); onDone();
    } catch (e) {
      const body = e.response?.data;
      if (body?.error === 'conflicting_count') setConflict(body.conflicts?.[0] || {});
      else setErr(body?.errors?.[0] ? `Not recorded: ${body.errors[0].problem.replace(/_/g, ' ')}.` : errorText(e, 'The count was not recorded.'));
      if (body?.error === 'idempotency_conflict') key.current = newKey();
    } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <p className="side-note">Count every unit physically at this location. A count includes every shipment or adjustment up to its time; later movements are applied on top.</p>
      <div className="coverage-fields">
        <div><label htmlFor="cnt-qty" className="label-text">Units counted</label>
          <input id="cnt-qty" type="number" min="0" step="1" inputMode="numeric" className="input-field" value={qty} onChange={e => setQty(e.target.value)} placeholder="e.g. 24" /></div>
        <div><label htmlFor="cnt-when" className="label-text">Counted at ({browserZone()})</label>
          <input id="cnt-when" type="datetime-local" className="input-field" value={when} max={localNow()} onChange={e => setWhen(e.target.value)} /></div>
      </div>
      {conflict && (
        <div className="result-notes" role="alert" style={{ paddingTop: 10 }}>
          <p><HiExclamationTriangle style={{ color: 'var(--warning)' }} /> A different count ({fmtNum(conflict.recorded_quantity)}) is already recorded for this product at exactly this time. Nothing was recorded.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="secondary" onClick={() => setConflict(null)}>Keep the recorded count</Button>
            <Button size="sm" onClick={() => submit(true)} disabled={busy}>Replace it with {qty}</Button>
          </div>
        </div>
      )}
      {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      <Button onClick={() => submit(false)} disabled={busy || qty === '' || !when}>{busy ? 'Recording…' : 'Record count'}</Button>
    </div>
  );
}

function AdjustForm({ item, onDone }) {
  const [form, setForm] = useState({ kind: 'damage', quantity: '', when: localNow(), reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const key = useRef(newKey());
  const set = (p) => setForm(f => ({ ...f, ...p }));
  const needsReason = form.kind !== 'customer_return';
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/inventory/movements', { idempotency_key: key.current, product_id: item.product_id, kind: form.kind,
        quantity: Number(form.quantity), effective_at: toInstant(form.when), reason: form.reason || undefined });
      toast.success('Adjustment recorded'); key.current = newKey(); setForm(f => ({ ...f, quantity: '', reason: '' })); onDone();
    } catch (e) { setErr(errorText(e, 'The adjustment was not recorded.')); if (e.response?.status === 409) key.current = newKey(); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <p className="side-note">{item.stock.known ? 'Applied on top of the last count if it happened after it.' : 'No count yet: the adjustment is kept and applied once a count exists before it.'} Shipments come from connected sources; receipts will come from purchase orders.</p>
      <div className="coverage-fields">
        <div><label htmlFor="adj-kind" className="label-text">Type</label>
          <select id="adj-kind" className="select-field input-field" value={form.kind} onChange={e => set({ kind: e.target.value })}>
            {['damage', 'found', 'customer_return', 'correction'].map(k => <option key={k} value={k}>{KINDS[k]}</option>)}
          </select></div>
        <div><label htmlFor="adj-qty" className="label-text">{form.kind === 'correction' ? 'Units (+ adds, − removes)' : 'Units'}</label>
          <input id="adj-qty" type="number" step="1" min={form.kind === 'correction' ? undefined : 1} className="input-field" value={form.quantity} onChange={e => set({ quantity: e.target.value })} /></div>
        <div><label htmlFor="adj-when" className="label-text">When ({browserZone()})</label>
          <input id="adj-when" type="datetime-local" className="input-field" value={form.when} max={localNow()} onChange={e => set({ when: e.target.value })} /></div>
        <div><label htmlFor="adj-reason" className="label-text">Reason{needsReason ? '' : ' (optional)'}</label>
          <input id="adj-reason" className="input-field" value={form.reason} onChange={e => set({ reason: e.target.value })} placeholder="e.g. broken in transit" /></div>
      </div>
      {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      <Button onClick={submit} disabled={busy || !form.quantity || !form.when || (needsReason && !form.reason.trim())}>{busy ? 'Recording…' : 'Record adjustment'}</Button>
    </div>
  );
}

function PolicyForm({ item, onDone }) {
  const [threshold, setThreshold] = useState(item.policy.reorder_threshold ?? '');
  const [stale, setStale] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/inventory/items/${item.product_id}/policy`, {
        reorder_threshold: threshold === '' ? null : Number(threshold), ...(stale !== '' ? { stale_after_days: Number(stale) } : {}) });
      toast.success('Settings saved'); onDone();
    } catch (e) { setErr(errorText(e, 'Settings were not saved.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <p className="side-note">Set manually. Threshold source: {item.policy.threshold_source === 'legacy_migration' ? 'copied from the old stock column (the old upload used 10 when a file had none)' : item.policy.threshold_source || 'not set'}. Count tolerance now: {item.policy.stale_after_days} days.</p>
      <div className="coverage-fields">
        <div><label htmlFor="pol-thr" className="label-text">Reorder threshold (units)</label>
          <input id="pol-thr" type="number" min="0" step="1" className="input-field" value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="not set" /></div>
        <div><label htmlFor="pol-stale" className="label-text">Recount after (days)</label>
          <input id="pol-stale" type="number" min="1" max="365" step="1" className="input-field" value={stale} onChange={e => setStale(e.target.value)} placeholder={`${item.policy.stale_after_days}`} /></div>
      </div>
      {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
    </div>
  );
}

function History({ item, onDone }) {
  const [busy, setBusy] = useState(null);
  const revoke = async (batchId) => {
    setBusy(batchId);
    try { await api.post(`/inventory/snapshots/${batchId}/revoke`); toast.success('Count revoked; the earlier position applies again'); onDone(); }
    catch (e) { toast.error(errorText(e, 'The count was not revoked.')); }
    finally { setBusy(null); }
  };
  return (
    <div className="stack">
      <div>
        <p className="side-label">Counts</p>
        {item.counts.length ? (
          <div className="table-scroll" style={{ maxHeight: 220 }}>
            <table className="data-table"><tbody>
              {item.counts.map(c => (
                <tr key={c.id} className={c.status !== 'active' ? 'is-muted' : ''}>
                  <td>{c.observed_at ? fmtWhen(c.observed_at) : <span className="text-faint">no count time</span>}</td>
                  <td className="is-num">{fmtNum(c.quantity)}</td>
                  <td>{SOURCE_KIND[c.source_kind]}</td>
                  <td>{c.selected ? <StatusBadge tone="success">In use</StatusBadge> : c.verification === 'unverified' ? <StatusBadge tone="warning">Unverified</StatusBadge> : <StatusBadge tone="neutral">{c.status}</StatusBadge>}</td>
                  <td style={{ textAlign: 'right' }}>{c.status === 'active' && ['manual_count', 'connector'].includes(c.source_kind) &&
                    <button className="btn-ghost btn-sm text-critical" disabled={busy === c.batch_id} onClick={() => revoke(c.batch_id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        ) : <p className="side-note">No counts yet.</p>}
      </div>
      <div>
        <p className="side-label">Movements</p>
        {item.movements.length ? (
          <div className="table-scroll" style={{ maxHeight: 220 }}>
            <table className="data-table"><tbody>
              {item.movements.map(m => (
                <tr key={m.id}>
                  <td>{fmtWhen(m.effective_at)}</td>
                  <td>{KINDS[m.kind]}{m.order_ref ? <span className="list-row-aside"> · {m.order_ref}</span> : ''}</td>
                  <td className="is-num" style={{ color: m.quantity < 0 ? 'var(--danger)' : 'var(--success)' }}>{m.quantity > 0 ? '+' : ''}{m.quantity}</td>
                  <td className="cell-note">{RELATION[m.relation]}{m.reason ? ` · ${m.reason}` : ''}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        ) : <p className="side-note">No movements recorded.</p>}
      </div>
      <p className="side-note">Stock-count files are undone with Rollback on the Data Integration page.</p>
    </div>
  );
}

// ── Bulk stock count ─────────────────────────────────────────────────────────
function CountFileDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [when, setWhen] = useState(localNow);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const op = useRef(newKey());
  const submit = async (supersede = false) => {
    setBusy(true); setErr(null);
    if (supersede) op.current = newKey();
    const form = new FormData();
    form.append('file', file);
    form.append('counted_at', toInstant(when));
    form.append('operation_id', op.current);
    if (supersede) form.append('supersede', 'true');
    try {
      const r = await api.post('/inventory/count-files', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(r.data); setConflicts(null); onDone();
    } catch (e) {
      const body = e.response?.data;
      if (body?.error === 'conflicting_count') setConflicts(body);
      else setErr(body?.rejected_rows ? `${body.message} ${body.rejected_rows.slice(0, 5).map(r => `row ${r.row}: ${r.problem.replace(/_/g, ' ')}`).join('; ')}` : errorText(e, 'The file was not imported.'));
      op.current = newKey();
    } finally { setBusy(false); }
  };
  return (
    <Dialog onClose={onClose} labelledBy="count-file-title" busy={busy}>
      <p className="dialog-kicker" style={{ color: 'var(--inventory)' }}>Stock count</p>
      <h2 id="count-file-title" className="dialog-title" style={{ marginTop: 10 }}>Upload a stock-count file</h2>
      {result ? (
        <div className="stack" style={{ marginTop: 14 }}>
          <p className="side-note">Version #{result.version_number}: {result.recorded} count{result.recorded === 1 ? '' : 's'} recorded{result.already_recorded ? `, ${result.already_recorded} already recorded` : ''}{result.superseded ? `, ${result.superseded} replaced` : ''}. {result.note}</p>
          {result.rejected > 0 && (
            <div className="result-notes" style={{ paddingTop: 10 }}>
              <p><HiExclamationTriangle style={{ color: 'var(--warning)' }} /> {result.rejected} row{result.rejected === 1 ? ' was' : 's were'} not recorded:</p>
              <ul className="overlap-list">{result.rejected_rows.map(r => <li key={r.row}>Row {r.row}: {r.problem.replace(/_/g, ' ')}{r.value ? ` (${r.value})` : ''}</li>)}</ul>
            </div>
          )}
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 14 }}>
          <p className="side-note">CSV, Excel or JSON with columns <code className="code-chip">product_name</code> and <code className="code-chip">quantity</code>. Products must already exist; products not listed keep their earlier counts. The file becomes an import version and can be rolled back.</p>
          <div><label htmlFor="cf-file" className="label-text">File</label>
            <input id="cf-file" type="file" accept=".csv,.xlsx,.xls,.json" className="input-field" onChange={e => setFile(e.target.files?.[0] || null)} /></div>
          <div><label htmlFor="cf-when" className="label-text">Counted at ({browserZone()})</label>
            <input id="cf-when" type="datetime-local" className="input-field" value={when} max={localNow()} onChange={e => setWhen(e.target.value)} /></div>
          {conflicts && (
            <div className="result-notes" role="alert" style={{ paddingTop: 10 }}>
              <p><HiExclamationTriangle style={{ color: 'var(--warning)' }} /> {conflicts.conflict_count} product{conflicts.conflict_count === 1 ? ' has' : 's have'} a different count recorded at exactly this time. Nothing was imported.</p>
              <Button size="sm" onClick={() => submit(true)} disabled={busy}>Replace those counts</Button>
            </div>
          )}
          {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} disabled={busy} className="btn-secondary" style={{ flex: 1 }}>Cancel</button>
            <button onClick={() => submit(false)} disabled={busy || !file || !when} className="btn-primary" style={{ flex: 1 }}>{busy ? 'Importing…' : 'Import counts'}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SettingsDialog({ onClose, onDone }) {
  const [view, setView] = useState(null);
  const [form, setForm] = useState({ stale: '', threshold: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get('/inventory/policy').then(r => {
      setView(r.data);
      setForm({ stale: String(r.data.effective.stale_after_days), threshold: r.data.effective.reorder_threshold ?? '' });
    }).catch(e => setErr(errorText(e, 'Settings could not be loaded.')));
  }, []);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch('/inventory/policy', { stale_after_days: Number(form.stale), reorder_threshold: form.threshold === '' ? null : Number(form.threshold) });
      toast.success('Defaults saved'); onDone(); onClose();
    } catch (e) { setErr(errorText(e, 'Settings were not saved.')); }
    finally { setBusy(false); }
  };
  return (
    <Dialog onClose={onClose} labelledBy="inv-settings-title" busy={busy}>
      <p className="dialog-kicker" style={{ color: 'var(--inventory)' }}>Defaults for all products</p>
      <h2 id="inv-settings-title" className="dialog-title" style={{ marginTop: 10 }}>Inventory settings</h2>
      {!view && !err ? <div style={{ marginTop: 14 }}><Skeleton height={120} /></div> : (
        <div className="stack" style={{ marginTop: 14 }}>
          <p className="side-note">{view?.note} A product's own settings take precedence.</p>
          <div className="coverage-fields">
            <div><label htmlFor="set-stale" className="label-text">Recount after (days)</label>
              <input id="set-stale" type="number" min="1" max="365" className="input-field" value={form.stale} onChange={e => setForm(f => ({ ...f, stale: e.target.value }))} /></div>
            <div><label htmlFor="set-thr" className="label-text">Default reorder threshold</label>
              <input id="set-thr" type="number" min="0" className="input-field" value={form.threshold} placeholder="not set" onChange={e => setForm(f => ({ ...f, threshold: e.target.value }))} /></div>
          </div>
          {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} disabled={busy} className="btn-secondary" style={{ flex: 1 }}>Cancel</button>
            <button onClick={save} disabled={busy || !view || !form.stale} className="btn-primary" style={{ flex: 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
