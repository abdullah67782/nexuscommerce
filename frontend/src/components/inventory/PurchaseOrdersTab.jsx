'use client';
// Purchase orders (Stage 1b): draft → approved → ordered → partially received →
// received, or cancelled. Approval and ordering never change stock; receiving
// records the stock movement. Corrections (recorded wrongly) and supplier returns
// (goods sent back) are separate actions. Every change sends the order version,
// so a concurrent change is refused instead of overwritten.
import { useState, useEffect, useCallback, useRef } from 'react';
import Dialog from '../Dialog';
import { Panel, PanelHeader } from '../ui/Panel';
import Button from '../ui/Button';
import Segmented from '../ui/Segmented';
import StatusBadge from '../ui/StatusBadge';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { HiPlus, HiArrowPath, HiExclamationTriangle, HiDocumentText, HiTrash } from 'react-icons/hi2';

const STATUS = {
  draft: { tone: 'neutral', label: 'Draft' }, approved: { tone: 'info', label: 'Approved' },
  ordered: { tone: 'accent', label: 'Ordered' }, partially_received: { tone: 'warning', label: 'Partially received' },
  received: { tone: 'success', label: 'Received' }, cancelled: { tone: 'critical', label: 'Cancelled' },
};
const FILTERS = ['open', 'draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled', 'all'];
const EVENTS = {
  created: 'Draft created', edited: 'Draft edited', approved: 'Approved (no stock change)', ordered: 'Marked as ordered (incoming, not on-hand)',
  received_goods: 'Goods received', receipt_corrected: 'Receipt corrected', goods_returned: 'Returned to supplier',
  status_changed: 'Status changed', expected_arrival_changed: 'Expected arrival changed', cancelled: 'Cancelled',
};
const KIND = { receipt: 'receipt', receipt_correction: 'correction', supplier_return: 'return' };
const errorText = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback;
const problemsOf = (e) => e?.response?.data?.problems || e?.response?.data?.errors || [];
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toInstant = (local) => (local ? new Date(local).toISOString() : null);
const label = (s) => (STATUS[s] || { label: s }).label;
const packProblem = (q, pack, moq) => {
  if (!q) return null;
  if (q < moq) return `Minimum order is ${moq}.`;
  if (q % pack) { const lo = Math.floor(q / pack) * pack; return `Packs of ${pack}: ${lo || pack} or ${lo + pack}.`; }
  return null;
};

export default function PurchaseOrdersTab() {
  const [filter, setFilter] = useState('open');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData((await api.get(`/purchase-orders?page_size=100${filter === 'all' ? '' : `&status=${filter}`}`)).data);
      setError(null);
    } catch (e) { setError(errorText(e, 'Purchase orders could not be loaded.')); }
    finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { queueMicrotask(load); }, [load]);

  return (
    <>
      <Panel aria-labelledby="po-title">
        <PanelHeader title="Purchase orders" titleId="po-title" description="Incoming quantities stay separate from on-hand stock until goods are received.">
          <Button variant="secondary" size="sm" onClick={load} disabled={loading} icon={<HiArrowPath className={loading ? 'spin' : ''} />}>Refresh</Button>
          <Button size="sm" onClick={() => setCreating(true)} icon={<HiPlus />}>New purchase order</Button>
        </PanelHeader>
        <div className="panel-toolbar">
          <Segmented label="Status" value={filter} onChange={setFilter}
            options={FILTERS.map(f => ({ value: f, label: f === 'open' ? 'Open' : f === 'all' ? 'All' : label(f) }))} />
        </div>
        {error && !data ? (
          <EmptyState icon={<HiExclamationTriangle />} title="Purchase orders could not be loaded" action={<Button variant="secondary" onClick={load}>Retry</Button>}>{error}</EmptyState>
        ) : !data ? (
          <div className="panel-body"><Skeleton height={120} /></div>
        ) : !data.purchase_orders.length ? (
          <EmptyState icon={<HiDocumentText />} title={filter === 'open' ? 'No open purchase orders' : 'No purchase orders here'}
            action={<Button onClick={() => setCreating(true)} icon={<HiPlus />}>New purchase order</Button>}>
            Create a draft from a supplier&apos;s products. Approving or ordering never changes stock; receiving does.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>{['Order', 'Supplier', 'Status', 'Expected arrival', 'Ordered', 'Received', 'Remaining', 'Returned'].map(h => <th key={h} className={['Ordered', 'Received', 'Remaining', 'Returned'].includes(h) ? 'is-num' : ''}>{h}</th>)}</tr></thead>
              <tbody>
                {data.purchase_orders.map(p => (
                  <tr key={p.id} className="is-clickable" tabIndex={0} aria-label={`Open purchase order ${p.id}`}
                    onClick={() => setOpen(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(p.id); }}>
                    <td className="is-strong is-mono">PO-{p.id}</td>
                    <td>{p.supplier_name}</td>
                    <td><StatusBadge tone={STATUS[p.status].tone}>{label(p.status)}</StatusBadge></td>
                    <td>{p.expected_arrival || <span className="text-faint">not set</span>}{p.overdue && <span style={{ display: 'block', marginTop: 4 }}><StatusBadge tone="critical">Overdue</StatusBadge></span>}</td>
                    <td className="is-num">{fmtNum(p.ordered)}</td>
                    <td className="is-num">{fmtNum(p.received)}</td>
                    <td className="is-num">{fmtNum(p.remaining)}</td>
                    <td className="is-num">{fmtNum(p.returned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {creating && <NewOrderDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); load(); }} />}
      {open && <OrderDialog key={open} id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

// ── New draft ────────────────────────────────────────────────────────────────
function NewOrderDialog({ onClose, onCreated }) {
  const [suppliers, setSuppliers] = useState(null);
  const [supplier, setSupplier] = useState(null);
  const [qty, setQty] = useState({});
  const [form, setForm] = useState({ currency: '', expected_arrival: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const key = useRef(newKey());
  useEffect(() => { api.get('/suppliers').then(r => setSuppliers(r.data.suppliers.filter(s => s.active))).catch(e => setErr(errorText(e, 'Suppliers could not be loaded.'))); }, []);
  const pick = async (id) => {
    setSupplier(null); setQty({});
    if (!id) return;
    try {
      const s = (await api.get(`/suppliers/${id}`)).data;
      setSupplier(s); setForm(f => ({ ...f, currency: s.default_currency }));
    } catch (e) { setErr(errorText(e, 'The supplier could not be loaded.')); }
  };
  const links = supplier ? supplier.links.filter(l => l.active) : [];
  const lines = links.filter(l => Number(qty[l.product_id]) > 0).map(l => ({ product_id: l.product_id, quantity: Number(qty[l.product_id]) }));
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/purchase-orders', { idempotency_key: key.current, supplier_id: supplier.id, currency: form.currency,
        expected_arrival: form.expected_arrival || null, notes: form.notes || null, lines });
      toast.success(`Draft PO-${r.data.purchase_order.id} created`); onCreated(r.data.purchase_order.id);
    } catch (e) {
      setErr(`${errorText(e, 'The draft was not created.')} ${problemsOf(e).map(p => p.detail || p.problem).join(' ')}`);
      key.current = newKey();
    } finally { setBusy(false); }
  };
  return (
    <Dialog onClose={onClose} labelledBy="new-po-title" busy={busy} wide>
      <p className="dialog-kicker" style={{ color: 'var(--inventory)' }}>Purchase order</p>
      <h2 id="new-po-title" className="dialog-title" style={{ marginTop: 8 }}>New draft</h2>
      <div className="stack" style={{ marginTop: 14 }}>
        <div className="coverage-fields">
          <div><label htmlFor="po-sup" className="label-text">Supplier</label>
            <select id="po-sup" className="select-field input-field" defaultValue="" onChange={e => pick(e.target.value)}>
              <option value="">Choose a supplier…</option>
              {(suppliers || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div><label htmlFor="po-cur" className="label-text">Order currency (one per order)</label>
            <input id="po-cur" className="input-field" maxLength={3} value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></div>
          <div><label htmlFor="po-eta" className="label-text">Expected arrival (optional)</label>
            <input id="po-eta" type="date" className="input-field" value={form.expected_arrival} onChange={e => setForm(f => ({ ...f, expected_arrival: e.target.value }))} /></div>
          <div><label htmlFor="po-notes" className="label-text">Notes (optional)</label>
            <input id="po-notes" className="input-field" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        </div>
        {supplier && (links.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>{['Product', 'Unit cost', 'Min order', 'Pack', 'Quantity'].map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {links.map(l => {
                  const q = Number(qty[l.product_id]) || 0;
                  const warn = packProblem(q, l.pack_size, l.min_order_qty);
                  return (
                    <tr key={l.product_id}>
                      <td className="is-strong">{l.product_name}</td>
                      <td>{l.unit_cost == null ? <StatusBadge tone="warning">Cost not set</StatusBadge> : `${l.currency} ${Number(l.unit_cost).toFixed(2)}`}
                        {l.unit_cost != null && l.currency !== form.currency && <span className="list-row-aside" style={{ display: 'block', color: 'var(--warning)' }}>not in {form.currency}</span>}</td>
                      <td>{l.min_order_qty}</td>
                      <td>{l.pack_size}</td>
                      <td style={{ minWidth: 150 }}>
                        <input type="number" min="0" step={l.pack_size} className="input-field" aria-label={`Quantity of ${l.product_name}`}
                          value={qty[l.product_id] ?? ''} onChange={e => setQty(x => ({ ...x, [l.product_id]: e.target.value }))} />
                        {warn && <span className="list-row-aside" style={{ display: 'block', color: 'var(--warning)', fontSize: 12 }}>{warn} Approval will be refused until fixed.</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="side-note">This supplier has no products linked. Add terms on the Suppliers tab first.</p>)}
        {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={busy} className="btn-secondary" style={{ flex: 1 }}>Cancel</button>
          <button onClick={create} disabled={busy || !supplier || !lines.length || form.currency.length !== 3} className="btn-primary" style={{ flex: 1 }}>{busy ? 'Creating…' : 'Create draft'}</button>
        </div>
      </div>
    </Dialog>
  );
}

// ── One order ────────────────────────────────────────────────────────────────
function OrderDialog({ id, onClose, onChanged }) {
  const [po, setPo] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(null); // 'receive' | 'cancel' | {kind, receipt}
  const [effects, setEffects] = useState(null);
  const load = useCallback(async () => {
    try { setPo((await api.get(`/purchase-orders/${id}`)).data); }
    catch (e) { setErr(errorText(e, 'The order could not be loaded.')); }
  }, [id]);
  useEffect(() => { queueMicrotask(load); }, [load]);

  // Every change carries the version; a conflict reloads instead of overwriting.
  const run = async (fn, success) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      setPo(r.data.purchase_order);
      setEffects(r.data.stock_effects?.length ? r.data.stock_effects : null);
      setPanel(null); toast.success(success); onChanged();
      return true;
    } catch (e) {
      const body = e.response?.data;
      if (body?.error === 'version_conflict') { await load(); setErr(`${body.message} The latest version is shown now.`); }
      else setErr(`${errorText(e, 'Not done.')} ${problemsOf(e).map(p => p.detail || p.problem).join(' ')}`.trim());
      return false;
    } finally { setBusy(false); }
  };

  if (!po) {
    return (
      <Dialog onClose={onClose} labelledBy="po-dialog-title" wide>
        <h2 id="po-dialog-title" className="dialog-title">Purchase order</h2>
        {err ? <EmptyState icon={<HiExclamationTriangle />} title="Could not load" action={<Button variant="secondary" onClick={load}>Retry</Button>}>{err}</EmptyState>
          : <div style={{ marginTop: 14 }}><Skeleton height={200} /></div>}
      </Dialog>
    );
  }
  const st = STATUS[po.status];
  const unknownCosts = po.lines.some(l => l.unit_cost == null);
  const open = ['ordered', 'partially_received'].includes(po.status);
  return (
    <Dialog onClose={onClose} labelledBy="po-dialog-title" busy={busy} wide>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
        <div>
          <p className="dialog-kicker" style={{ color: 'var(--inventory)' }}>{po.supplier.name} · {po.currency} · version {po.version}</p>
          <h2 id="po-dialog-title" className="dialog-title" style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
            PO-{po.id} <StatusBadge tone={st.tone}>{st.label}</StatusBadge>{po.overdue && <StatusBadge tone="critical">Overdue</StatusBadge>}
          </h2>
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="detail-body" style={{ marginTop: 14 }}>
        <div className="detail-grid">
          <div><span>Ordered</span><strong>{fmtNum(po.totals.ordered)}</strong></div>
          <div><span>Received (net of corrections)</span><strong>{fmtNum(po.totals.received)}</strong></div>
          <div><span>Incoming (remaining)</span><strong>{fmtNum(po.totals.inbound)}</strong><em className="side-note" style={{ fontStyle: 'normal' }}>not in on-hand until received</em></div>
          <div><span>Returned to supplier · cancelled</span><strong>{fmtNum(po.totals.returned)} · {fmtNum(po.totals.cancelled)}</strong></div>
        </div>
        <p className="side-note">Total cost: {po.totals.cost == null ? (po.unknown_costs_accepted ? 'some costs explicitly marked unknown' : 'incomplete (some costs not set)') : `${po.currency} ${po.totals.cost.toFixed(2)}`}.
          {po.cancel_reason ? ` Cancelled: ${po.cancel_reason}. Received goods were kept; a cancelled order never reopens.` : ''}</p>

        <div className="table-scroll">
          <table className="data-table">
            <thead><tr>{['Product', 'Ordered', 'Received', 'Returned', 'Cancelled', 'Remaining', 'Terms'].map(h => <th key={h} className={h !== 'Product' && h !== 'Terms' ? 'is-num' : ''}>{h}</th>)}</tr></thead>
            <tbody>
              {po.lines.map(l => (
                <tr key={l.id}>
                  <td className="is-strong">{l.product_name}{l.problems.length > 0 && po.status === 'draft' && <span className="list-row-aside" style={{ display: 'block', color: 'var(--warning)', fontSize: 12 }}>{l.problems.map(p => p.detail).join(' ')}</span>}</td>
                  <td className="is-num">{l.quantity_ordered}</td>
                  <td className="is-num">{l.quantity_received}{l.quantity_corrected > 0 && <span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>{l.quantity_corrected} corrected</span>}</td>
                  <td className="is-num">{l.quantity_returned}</td>
                  <td className="is-num">{l.quantity_cancelled}</td>
                  <td className="is-num">{l.quantity_remaining}</td>
                  <td className="cell-note">{l.unit_cost == null ? 'cost not set' : `${l.cost_currency} ${l.unit_cost.toFixed(2)}`} · pack {l.pack_size} · min {l.min_order_qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {effects && (
          <div className="result-notes" style={{ paddingTop: 10 }}>
            <p>Stock effects: {effects.map(e => `${e.product_name || `product ${e.product_id}`} ${e.quantity > 0 ? '+' : ''}${e.quantity} (${KIND[e.kind] || e.kind}, movement #${e.movement_id})`).join('; ')}.</p>
          </div>
        )}
        {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {po.status === 'draft' && <ApproveButton po={po} unknownCosts={unknownCosts} busy={busy}
            onApprove={(accept) => run(() => api.post(`/purchase-orders/${po.id}/approve`, { version: po.version, accept_unknown_costs: accept }), 'Approved — stock unchanged')} />}
          {po.status === 'approved' && <Button disabled={busy} onClick={() => run(() => api.post(`/purchase-orders/${po.id}/mark-ordered`, { version: po.version }), 'Marked as ordered')}>Mark as ordered</Button>}
          {open && <Button disabled={busy} onClick={() => setPanel('receive')}>Receive goods</Button>}
          {['draft', 'approved', 'ordered', 'partially_received'].includes(po.status) && (
            <Button variant="danger" disabled={busy} icon={<HiTrash />} onClick={() => setPanel('cancel')}>{open && po.totals.received ? 'Cancel the remainder' : 'Cancel order'}</Button>)}
        </div>

        {['draft', 'approved', 'ordered', 'partially_received'].includes(po.status) && <ArrivalForm po={po} busy={busy}
          onSave={(date, reason) => run(() => api.patch(`/purchase-orders/${po.id}`, { version: po.version, expected_arrival: date || null, reason }), 'Expected arrival updated')} />}
        {po.status === 'draft' && <DraftLinesForm po={po} busy={busy}
          onSave={(lines) => run(() => api.patch(`/purchase-orders/${po.id}`, { version: po.version, lines }), 'Draft updated')} />}
        {panel === 'receive' && <ReceiveForm po={po} busy={busy} onCancel={() => setPanel(null)}
          onSubmit={(body) => run(() => api.post(`/purchase-orders/${po.id}/receipts`, body), 'Receipt recorded')} />}
        {panel === 'cancel' && <CancelForm po={po} busy={busy} onCancel={() => setPanel(null)}
          onSubmit={(reason) => run(() => api.post(`/purchase-orders/${po.id}/cancel`, { version: po.version, reason }), 'Order cancelled')} />}

        {po.receipts.length > 0 && (
          <div className="stack">
            <p className="side-label">Receipts</p>
            {po.receipts.map(r => (
              <div key={r.id} className="panel panel-subtle" style={{ padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <strong>Receipt #{r.id} · {fmtWhen(r.received_at)}</strong>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPanel({ kind: 'correction', receipt: r })}>Correct receipt</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPanel({ kind: 'supplier_return', receipt: r })}>Return to supplier</Button>
                  </span>
                </div>
                <p className="side-note" style={{ marginTop: 6 }}>{r.lines.map(l => `${po.lines.find(x => x.product_id === l.product_id)?.product_name}: ${l.quantity} received (movement #${l.movement_id})${l.corrected ? `, ${l.corrected} corrected` : ''}${l.returned ? `, ${l.returned} returned` : ''}`).join(' · ')}</p>
                {panel?.receipt?.id === r.id && <AdjustForm po={po} receipt={r} kind={panel.kind} busy={busy} onCancel={() => setPanel(null)}
                  onSubmit={(body) => run(() => api.post(`/purchase-orders/${po.id}/receipts/${r.id}/${panel.kind === 'correction' ? 'corrections' : 'returns'}`, body),
                    panel.kind === 'correction' ? 'Receipt corrected' : 'Return recorded')} />}
              </div>
            ))}
          </div>
        )}

        <div className="stack">
          <p className="side-label">History</p>
          <ol className="po-timeline">
            {po.events.map(e => (
              <li key={e.id}>
                <span className="side-note">{fmtWhen(e.at)}</span>
                <span><strong>{EVENTS[e.event] || e.event}</strong>{e.from_status && e.to_status && e.from_status !== e.to_status ? ` · ${label(e.from_status)} → ${label(e.to_status)}` : ''}
                  {e.event === 'expected_arrival_changed' && ` · ${e.detail.from || 'not set'} → ${e.detail.to || 'not set'}${e.detail.reason ? ` (${e.detail.reason})` : ''}`}
                  {e.detail?.reason && e.event !== 'expected_arrival_changed' ? ` · ${e.detail.reason}` : ''}
                  {e.detail?.stock_effects?.length ? ` · ${e.detail.stock_effects.map(x => `${x.quantity > 0 ? '+' : ''}${x.quantity} ${x.product_name || ''} (#${x.movement_id})`).join(', ')}` : ''}
                  {e.detail?.cause ? ` · ${e.detail.cause}` : ''}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Dialog>
  );
}

function ApproveButton({ po, unknownCosts, busy, onApprove }) {
  const [accept, setAccept] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button disabled={busy || (unknownCosts && !accept)} onClick={() => onApprove(accept)}>Approve</Button>
      {unknownCosts && (
        <label className="side-note" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={accept} onChange={e => setAccept(e.target.checked)} /> Approve with costs marked unknown
        </label>)}
    </span>
  );
}

function ArrivalForm({ po, busy, onSave }) {
  const [date, setDate] = useState(po.expected_arrival || '');
  const [reason, setReason] = useState('');
  const changed = (date || null) !== (po.expected_arrival || null);
  return (
    <div className="coverage-fields" style={{ alignItems: 'end' }}>
      <div><label htmlFor="po-arrival" className="label-text">Expected arrival (supplier promise)</label>
        <input id="po-arrival" type="date" className="input-field" value={date} onChange={e => setDate(e.target.value)} /></div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
        <div style={{ flex: 1 }}><label htmlFor="po-arrival-reason" className="label-text">Reason (kept in history)</label>
          <input id="po-arrival-reason" className="input-field" value={reason} onChange={e => setReason(e.target.value)} /></div>
        <Button variant="secondary" disabled={busy || !changed} onClick={() => onSave(date, reason)}>Save</Button>
      </div>
    </div>
  );
}

function DraftLinesForm({ po, busy, onSave }) {
  const [q, setQ] = useState(Object.fromEntries(po.lines.map(l => [l.product_id, l.quantity_ordered])));
  const dirty = po.lines.some(l => Number(q[l.product_id]) !== l.quantity_ordered);
  return (
    <div className="stack">
      <p className="side-label">Edit draft quantities</p>
      <div className="coverage-fields">
        {po.lines.map(l => {
          const warn = packProblem(Number(q[l.product_id]) || 0, l.pack_size, l.min_order_qty);
          return (
            <div key={l.product_id}><label htmlFor={`dq-${l.product_id}`} className="label-text">{l.product_name}</label>
              <input id={`dq-${l.product_id}`} type="number" min="1" step={l.pack_size} className="input-field" value={q[l.product_id]}
                onChange={e => setQ(x => ({ ...x, [l.product_id]: e.target.value }))} />
              {warn && <span className="list-row-aside" style={{ display: 'block', color: 'var(--warning)', fontSize: 12 }}>{warn}</span>}</div>
          );
        })}
      </div>
      <div><Button variant="secondary" disabled={busy || !dirty}
        onClick={() => onSave(po.lines.map(l => ({ product_id: l.product_id, quantity: Number(q[l.product_id]) })))}>Save quantities</Button></div>
    </div>
  );
}

function ReceiveForm({ po, busy, onCancel, onSubmit }) {
  const [q, setQ] = useState({});
  const [when, setWhen] = useState(localNow);
  const [note, setNote] = useState('');
  const key = useRef(newKey());
  const lines = po.lines.filter(l => Number(q[l.id]) > 0).map(l => ({ line_id: l.id, quantity: Number(q[l.id]) }));
  const over = po.lines.some(l => Number(q[l.id]) > l.quantity_remaining);
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <p className="side-label">Receive goods</p>
      <p className="side-note">Each received line becomes one stock movement at the time below. If a later physical count exists, that count stays authoritative. More than the remaining quantity cannot be received.</p>
      <div className="coverage-fields">
        {po.lines.filter(l => l.quantity_remaining > 0).map(l => (
          <div key={l.id}><label htmlFor={`rq-${l.id}`} className="label-text">{l.product_name} ({l.quantity_remaining} remaining)</label>
            <input id={`rq-${l.id}`} type="number" min="0" max={l.quantity_remaining} step="1" className="input-field" value={q[l.id] ?? ''}
              onChange={e => setQ(x => ({ ...x, [l.id]: e.target.value }))} /></div>
        ))}
        <div><label htmlFor="rq-when" className="label-text">Received at</label>
          <input id="rq-when" type="datetime-local" className="input-field" value={when} max={localNow()} onChange={e => setWhen(e.target.value)} /></div>
        <div><label htmlFor="rq-note" className="label-text">Note (optional)</label>
          <input id="rq-note" className="input-field" value={note} onChange={e => setNote(e.target.value)} /></div>
      </div>
      {over && <p className="side-note" style={{ color: 'var(--danger)' }}>That is more than remains on the order.</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Close</Button>
        <Button disabled={busy || !lines.length || over || !when}
          onClick={async () => { await onSubmit({ idempotency_key: key.current, received_at: toInstant(when), note: note || undefined, lines }); key.current = newKey(); }}>Record receipt</Button>
      </div>
    </div>
  );
}

function AdjustForm({ po, receipt, kind, busy, onCancel, onSubmit }) {
  const [q, setQ] = useState({});
  const [reason, setReason] = useState('');
  const [when, setWhen] = useState(localNow);
  const key = useRef(newKey());
  const lines = receipt.lines.filter(l => Number(q[l.receipt_line_id]) > 0).map(l => ({ receipt_line_id: l.receipt_line_id, quantity: Number(q[l.receipt_line_id]) }));
  const correction = kind === 'correction';
  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <p className="side-note">{correction
        ? 'Correction: the receipt was recorded wrongly. Only the corrected quantity is removed, effective at the receipt time, so a later physical count still decides stock. The order line reopens by that quantity.'
        : 'Return: goods physically go back to the supplier now. Stock drops at the return time; the received quantity on the order is unchanged.'}</p>
      <div className="coverage-fields">
        {receipt.lines.map(l => {
          const left = l.quantity - l.corrected - l.returned;
          const name = po.lines.find(x => x.product_id === l.product_id)?.product_name;
          return (
            <div key={l.receipt_line_id}><label htmlFor={`aq-${l.receipt_line_id}`} className="label-text">{name} (up to {left})</label>
              <input id={`aq-${l.receipt_line_id}`} type="number" min="0" max={left} step="1" className="input-field" value={q[l.receipt_line_id] ?? ''}
                onChange={e => setQ(x => ({ ...x, [l.receipt_line_id]: e.target.value }))} /></div>
          );
        })}
        {!correction && <div><label htmlFor="aq-when" className="label-text">Returned at</label>
          <input id="aq-when" type="datetime-local" className="input-field" value={when} max={localNow()} onChange={e => setWhen(e.target.value)} /></div>}
        <div><label htmlFor="aq-reason" className="label-text">Reason (required)</label>
          <input id="aq-reason" className="input-field" value={reason} onChange={e => setReason(e.target.value)} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Close</Button>
        <Button disabled={busy || !lines.length || !reason.trim()}
          onClick={async () => { await onSubmit({ idempotency_key: key.current, reason, lines, ...(correction ? {} : { returned_at: toInstant(when) }) }); key.current = newKey(); }}>
          {correction ? 'Record correction' : 'Record return'}</Button>
      </div>
    </div>
  );
}

function CancelForm({ po, busy, onCancel, onSubmit }) {
  const [reason, setReason] = useState('');
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <p className="side-label">Cancel {po.totals.received ? 'the remainder' : 'the order'}</p>
      <p className="side-note">{po.totals.received ? `${po.totals.received} received unit(s) stay in stock. ` : ''}The remaining {po.totals.remaining} unit(s) are closed. A cancelled order never reopens; create a new order if needed.</p>
      <div><label htmlFor="cancel-reason" className="label-text">Reason (required)</label>
        <input id="cancel-reason" className="input-field" value={reason} onChange={e => setReason(e.target.value)} /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Keep the order</Button>
        <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => onSubmit(reason)}>Cancel order</Button>
      </div>
    </div>
  );
}
