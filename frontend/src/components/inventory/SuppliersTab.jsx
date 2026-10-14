'use client';
// Suppliers and product–supplier terms (Stage 1b). Settings are entered by the
// seller; missing ones are shown explicitly ("Lead time not set"), never guessed.
// A unit cost always carries its own currency (never inferred from the supplier).
import { useState, useEffect, useCallback } from 'react';
import Dialog from '../Dialog';
import { Panel, PanelHeader } from '../ui/Panel';
import Button from '../ui/Button';
import StatusBadge from '../ui/StatusBadge';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import SupplierPerformance from './SupplierPerformance';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { HiPlus, HiArrowPath, HiExclamationTriangle, HiBuildingStorefront } from 'react-icons/hi2';

const errorText = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback;
const money = (v, c) => (v == null ? null : `${c || ''} ${Number(v).toFixed(2)}`.trim());

export default function SuppliersTab() {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null); // supplier id | 'new'
  const [perf, setPerf] = useState({});    // supplier id → delivery summary
  const request = useCallback(() => Promise.all([api.get('/suppliers'), api.get('/suppliers/performance').catch(() => null)]), []);
  const apply = useCallback(([r, p]) => {
    setList(r.data.suppliers); setError(null);
    setPerf(p ? Object.fromEntries(p.data.suppliers.map(x => [x.supplier_id, x])) : {});
  }, []);
  // After a change (event handlers): show loading, then refresh.
  const load = useCallback(async () => {
    setLoading(true);
    try { apply(await request()); }
    catch (e) { setError(errorText(e, 'Suppliers could not be loaded.')); }
    finally { setLoading(false); }
  }, [request, apply]);
  // First load: state is set only in the request's callbacks.
  useEffect(() => {
    let live = true;
    request().then(v => { if (live) apply(v); })
      .catch(e => { if (live) setError(errorText(e, 'Suppliers could not be loaded.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [request, apply]);

  return (
    <>
      <Panel aria-labelledby="suppliers-title">
        <PanelHeader title="Suppliers" titleId="suppliers-title" description="Who you buy from, and the terms for each product: cost, currency, lead time, minimum order and pack size.">
          <Button variant="secondary" size="sm" onClick={load} disabled={loading} icon={<HiArrowPath className={loading ? 'spin' : ''} />}>Refresh</Button>
          <Button size="sm" onClick={() => setOpen('new')} icon={<HiPlus />}>Add supplier</Button>
        </PanelHeader>
        {error && !list ? (
          <EmptyState icon={<HiExclamationTriangle />} title="Suppliers could not be loaded" action={<Button variant="secondary" onClick={load}>Retry</Button>}>{error}</EmptyState>
        ) : !list ? (
          <div className="panel-body"><Skeleton height={120} /></div>
        ) : !list.length ? (
          <EmptyState icon={<HiBuildingStorefront />} title="No suppliers yet" action={<Button onClick={() => setOpen('new')} icon={<HiPlus />}>Add supplier</Button>}>
            Add a supplier, then link products with their cost, lead time, minimum order and pack size.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>{['Supplier', 'Default currency', 'Products', 'Missing settings', 'Open orders', 'Deliveries', 'Status'].map(h => <th key={h} className={['Products', 'Open orders'].includes(h) ? 'is-num' : ''}>{h}</th>)}</tr></thead>
              <tbody>
                {list.map(s => (
                  <tr key={s.id} className={`is-clickable ${s.active ? '' : 'is-muted'}`} tabIndex={0} aria-label={`Open supplier ${s.name}`}
                    onClick={() => setOpen(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(s.id); }}>
                    <td className="is-strong">{s.name}<span className="list-row-aside" style={{ display: 'block', fontSize: 12 }}>{[s.email, s.phone].filter(Boolean).join(' · ') || 'No contact details'}</span></td>
                    <td className="is-mono">{s.default_currency}</td>
                    <td className="is-num">{s.products}</td>
                    <td>{s.missing_lead_time || s.missing_cost ? (
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {s.missing_lead_time > 0 && <StatusBadge tone="warning">{s.missing_lead_time} without lead time</StatusBadge>}
                        {s.missing_cost > 0 && <StatusBadge tone="warning">{s.missing_cost} without cost</StatusBadge>}
                      </span>) : s.products ? <StatusBadge tone="success">Complete</StatusBadge> : <span className="text-faint">No products linked</span>}</td>
                    <td className="is-num">{s.open_orders}</td>
                    <td>{(() => {
                      const p = perf[s.id];
                      if (!p || !p.orders.placed) return <span className="text-faint">No orders yet</span>;
                      return (<span className="side-note">{p.orders.delivered} delivered{p.lead_time.observed_orders ? ` · median ${p.lead_time.observed_median_days} d` : ''}
                        {p.promises.late ? <> · <StatusBadge tone="warning">{p.promises.late} late</StatusBadge></> : ''}</span>);
                    })()}</td>
                    <td>{s.active ? <StatusBadge tone="success">Active</StatusBadge> : <StatusBadge tone="neutral">Inactive</StatusBadge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {open && <SupplierDialog key={open} id={open === 'new' ? null : open} onClose={() => setOpen(null)} onChanged={load} onCreated={(id) => { setOpen(id); load(); }} />}
    </>
  );
}

function SupplierDialog({ id, onClose, onChanged, onCreated }) {
  const [s, setS] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', default_currency: 'PKR', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // link | 'new'
  const show = useCallback((d) => {
    setS(d);
    setForm({ name: d.name, email: d.email || '', phone: d.phone || '', default_currency: d.default_currency, notes: d.notes || '' });
  }, []);
  const load = useCallback(async () => {
    if (!id) return;
    try { show((await api.get(`/suppliers/${id}`)).data); } catch (e) { setErr(errorText(e, 'The supplier could not be loaded.')); }
  }, [id, show]);
  // First load: state is set only in the request's callbacks.
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    api.get(`/suppliers/${id}`).then(r => { if (live) show(r.data); })
      .catch(e => { if (live) setErr(errorText(e, 'The supplier could not be loaded.')); });
    return () => { live = false; };
  }, [id, show]);
  const set = (p) => setForm(f => ({ ...f, ...p }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!id) {
        const r = await api.post('/suppliers', { ...form, default_currency: form.default_currency.toUpperCase() });
        toast.success('Supplier added'); onCreated(r.data.id);
      } else {
        await api.patch(`/suppliers/${id}`, { ...form, default_currency: form.default_currency.toUpperCase() });
        toast.success('Supplier saved'); load(); onChanged();
      }
    } catch (e) { setErr(errorText(e, 'The supplier was not saved.')); }
    finally { setBusy(false); }
  };
  const toggleActive = async () => {
    setBusy(true);
    try { await api.patch(`/suppliers/${id}`, { active: !s.active }); load(); onChanged(); }
    catch (e) { toast.error(errorText(e, 'Not changed.')); }
    finally { setBusy(false); }
  };
  const removeLink = async (link) => {
    try { await api.delete(`/products/${link.product_id}/suppliers/${id}`); toast.success('Terms deactivated; existing orders keep theirs'); load(); onChanged(); }
    catch (e) { toast.error(errorText(e, 'Not removed.')); }
  };

  return (
    <Dialog onClose={onClose} labelledBy="supplier-title" busy={busy} wide>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <p className="dialog-kicker" style={{ color: 'var(--inventory)' }}>{id ? 'Supplier' : 'New supplier'}</p>
          <h2 id="supplier-title" className="dialog-title" style={{ marginTop: 8 }}>{s?.name || (id ? 'Loading…' : 'Add a supplier')}</h2>
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="stack" style={{ marginTop: 14 }}>
        <div className="coverage-fields">
          <div><label htmlFor="sup-name" className="label-text">Name</label>
            <input id="sup-name" className="input-field" value={form.name} onChange={e => set({ name: e.target.value })} /></div>
          <div><label htmlFor="sup-cur" className="label-text">Default currency (for new orders)</label>
            <input id="sup-cur" className="input-field" value={form.default_currency} maxLength={3} onChange={e => set({ default_currency: e.target.value.toUpperCase() })} /></div>
          <div><label htmlFor="sup-email" className="label-text">Email</label>
            <input id="sup-email" className="input-field" value={form.email} onChange={e => set({ email: e.target.value })} /></div>
          <div><label htmlFor="sup-phone" className="label-text">Phone</label>
            <input id="sup-phone" className="input-field" value={form.phone} onChange={e => set({ phone: e.target.value })} /></div>
        </div>
        <p className="side-note">Changing the default currency never changes costs already entered: every cost keeps its own currency.</p>
        {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={save} disabled={busy || !form.name.trim() || form.default_currency.length !== 3}>{id ? 'Save supplier' : 'Add supplier'}</Button>
          {s && <Button variant="secondary" onClick={toggleActive} disabled={busy}>{s.active ? 'Deactivate' : 'Reactivate'}</Button>}
        </div>

        {s && (
          <div className="stack">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <p className="side-label">Products and terms</p>
              {s.active && <Button size="sm" variant="secondary" icon={<HiPlus />} onClick={() => setEditing('new')}>Link a product</Button>}
            </div>
            {s.links.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr>{['Product', 'Unit cost', 'Lead time', 'Min order', 'Pack', ''].map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                  <tbody>
                    {s.links.map(l => (
                      <tr key={l.id} className={l.active ? '' : 'is-muted'}>
                        <td className="is-strong">{l.product_name}{l.is_preferred && l.active ? <span className="list-row-aside"> · preferred</span> : ''}{!l.active ? <span className="list-row-aside"> · inactive</span> : ''}</td>
                        <td>{l.unit_cost == null ? <StatusBadge tone="warning">Cost not set</StatusBadge> : money(l.unit_cost, l.currency)}</td>
                        <td>{l.lead_time_days == null ? <StatusBadge tone="warning">Lead time not set</StatusBadge> : `${l.lead_time_days} days${l.lead_time_max_days != null ? ` (up to ${l.lead_time_max_days})` : ''}`}</td>
                        <td>{l.min_order_qty}</td>
                        <td>{l.pack_size}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {s.active && <button className="btn-ghost btn-sm" onClick={() => setEditing(l)}>Edit</button>}
                          {l.active && <button className="btn-ghost btn-sm text-critical" onClick={() => removeLink(l)}>Remove</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="side-note">No products linked yet.</p>}
            {editing && <TermsForm supplier={s} link={editing === 'new' ? null : editing} onDone={() => { setEditing(null); load(); onChanged(); }} onCancel={() => setEditing(null)} />}
          </div>
        )}
        {s && <SupplierPerformance supplierId={id} />}
      </div>
    </Dialog>
  );
}

function TermsForm({ supplier, link, onDone, onCancel }) {
  const [products, setProducts] = useState([]);
  const [f, setF] = useState({
    product_id: link?.product_id || '', supplier_sku: link?.supplier_sku || '',
    unit_cost: link?.unit_cost ?? '', currency: link?.currency || supplier.default_currency,
    lead_time_days: link?.lead_time_days ?? '', lead_time_max_days: link?.lead_time_max_days ?? '',
    min_order_qty: link?.min_order_qty ?? 1, pack_size: link?.pack_size ?? 1,
    is_preferred: link?.is_preferred || false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/products').then(r => setProducts(r.data.products)).catch(() => setProducts([])); }, []);
  const set = (p) => setF(x => ({ ...x, ...p }));
  const linked = new Set(supplier.links.filter(l => l.active).map(l => l.product_id));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.put(`/products/${f.product_id}/suppliers/${supplier.id}`, {
        supplier_sku: f.supplier_sku || null,
        unit_cost: f.unit_cost === '' ? null : Number(f.unit_cost), currency: f.unit_cost === '' ? null : f.currency,
        lead_time_days: f.lead_time_days === '' ? null : Number(f.lead_time_days),
        lead_time_max_days: f.lead_time_max_days === '' ? null : Number(f.lead_time_max_days),
        min_order_qty: Number(f.min_order_qty), pack_size: Number(f.pack_size), is_preferred: f.is_preferred,
      });
      toast.success('Terms saved'); onDone();
    } catch (e) { setErr(errorText(e, 'Terms were not saved.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <p className="side-label">{link ? `Terms for ${link.product_name}` : 'Link a product'}</p>
      <div className="coverage-fields">
        <div><label htmlFor="t-prod" className="label-text">Product</label>
          <select id="t-prod" className="select-field input-field" value={f.product_id} disabled={Boolean(link)} onChange={e => set({ product_id: e.target.value })}>
            <option value="">Choose a product…</option>
            {products.filter(p => link || !linked.has(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div><label htmlFor="t-sku" className="label-text">Supplier SKU (optional)</label>
          <input id="t-sku" className="input-field" value={f.supplier_sku} onChange={e => set({ supplier_sku: e.target.value })} /></div>
        <div><label htmlFor="t-cost" className="label-text">Unit cost (blank = not set)</label>
          <input id="t-cost" type="number" min="0" step="0.01" className="input-field" value={f.unit_cost} onChange={e => set({ unit_cost: e.target.value })} /></div>
        <div><label htmlFor="t-cur" className="label-text">Cost currency</label>
          <input id="t-cur" className="input-field" maxLength={3} value={f.currency} onChange={e => set({ currency: e.target.value.toUpperCase() })} /></div>
        <div><label htmlFor="t-lead" className="label-text">Lead time, days (blank = not set)</label>
          <input id="t-lead" type="number" min="0" max="365" step="1" className="input-field" value={f.lead_time_days} onChange={e => set({ lead_time_days: e.target.value })} /></div>
        <div><label htmlFor="t-leadmax" className="label-text">Slowest delivery, days (optional)</label>
          <input id="t-leadmax" type="number" min={f.lead_time_days === '' ? 0 : f.lead_time_days} max="365" step="1" className="input-field" value={f.lead_time_max_days}
            disabled={f.lead_time_days === ''} onChange={e => set({ lead_time_max_days: e.target.value })} />
          <em className="side-note" style={{ fontStyle: 'normal' }}>The supplier&apos;s declared worst case. Shown as a late-delivery scenario; orders still use the usual lead time.</em></div>
        <div><label htmlFor="t-moq" className="label-text">Minimum order (units)</label>
          <input id="t-moq" type="number" min="1" step="1" className="input-field" value={f.min_order_qty} onChange={e => set({ min_order_qty: e.target.value })} /></div>
        <div><label htmlFor="t-pack" className="label-text">Pack size (units per pack)</label>
          <input id="t-pack" type="number" min="1" step="1" className="input-field" value={f.pack_size} onChange={e => set({ pack_size: e.target.value })} /></div>
        <label className="coverage-check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={f.is_preferred} onChange={e => set({ is_preferred: e.target.checked })} />
          <span><strong>Preferred supplier</strong><em>For this product (only one at a time).</em></span>
        </label>
      </div>
      {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={save} disabled={busy || !f.product_id || (f.unit_cost !== '' && f.currency.length !== 3)}>{busy ? 'Saving…' : 'Save terms'}</Button>
      </div>
    </div>
  );
}
