'use client';
// Store calendar (Inventory Stage 3a). Holidays are shown for planning only: their effect on sales is
// not known and the forecast is never changed for them. What changes a plan is what the seller enters:
// a closure, a supplier delay, or a demand change (labelled "your assumption" everywhere it is used).
import { useState, useEffect, useCallback } from 'react';
import { Panel, PanelHeader } from '../ui/Panel';
import Button from '../ui/Button';
import StatusBadge from '../ui/StatusBadge';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { HiArrowPath, HiPlus, HiExclamationTriangle, HiCheck } from 'react-icons/hi2';

const errorText = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback;
const KIND = {
  closure: { label: 'Closure', tone: 'critical', help: 'The location is closed: no sales, and a delivery due then is usable from the next open day.' },
  supplier_delay: { label: 'Supplier delay', tone: 'warning', help: 'Orders from this supplier expected inside these dates arrive later by the days you enter.' },
  demand_scenario: { label: 'Demand change', tone: 'info', help: 'Your assumption (for example +40% before Eid). Used in order quantities and labelled “assumed by you”; it is not a prediction.' },
  promotion: { label: 'Promotion', tone: 'info', help: 'With a % it is your demand assumption; without one it is shown for information only.' },
};
const HOLIDAY_STATUS = {
  expected: { tone: 'warning', label: 'Expected — confirm locally' },
  scheduled: { tone: 'neutral', label: 'Scheduled' },
  confirmed_by_seller: { tone: 'success', label: 'Confirmed by you' },
};
const dates = (a, b) => (a === b ? a : `${a} – ${b}`);
const today = () => new Date().toISOString().slice(0, 10);
const plus = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export default function CalendarTab() {
  const [settings, setSettings] = useState(null);
  const [cal, setCal] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const request = useCallback(() => {
    const from = today();
    return Promise.all([api.get('/calendar/settings'),
      api.get(`/calendar?from=${from}&to=${plus(from, 120)}${showCancelled ? '&include_cancelled=true' : ''}`)]);
  }, [showCancelled]);
  // After a change or a retry (event handlers): show loading, then refresh.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await request();
      setSettings(s.data); setCal(c.data); setError(null);
    } catch (e) { setError(errorText(e, 'The calendar could not be loaded.')); }
    finally { setLoading(false); }
  }, [request]);
  // First load and filter changes: state is set only in the request's callbacks (react-hooks/set-state-in-effect).
  useEffect(() => {
    let live = true;
    request()
      .then(([s, c]) => { if (live) { setSettings(s.data); setCal(c.data); setError(null); } })
      .catch(e => { if (live) setError(errorText(e, 'The calendar could not be loaded.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [request]);

  if (loading && !settings) return <Panel><div className="panel-body"><Skeleton height={160} /></div></Panel>;
  if (error && !settings) {
    return <Panel><EmptyState icon={<HiExclamationTriangle />} title="Calendar could not be loaded" action={<Button variant="secondary" onClick={load} icon={<HiArrowPath />}>Retry</Button>}>{error}</EmptyState></Panel>;
  }
  return (
    <div className="stack">
      {settings && !settings.calendar_in_replenishment && (
        <p className="side-note" role="status"><HiExclamationTriangle style={{ verticalAlign: '-2px', color: 'var(--warning)' }} /> The calendar is saved but replenishment does not use it yet (switched off on this server). Order suggestions are unchanged.</p>
      )}
      <CountryPanel settings={settings} onSaved={load} />
      <Panel>
        <PanelHeader title="Your calendar entries" subtitle="Closures, supplier delays, promotions and demand changes. Dates are in your stock location's timezone." />
        <div className="panel-toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <label className="side-note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} /> Show cancelled
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={load} disabled={loading} icon={<HiArrowPath className={loading ? 'spin' : ''} />}>Refresh</Button>
            <Button onClick={() => { setEditing(null); setAdding(true); }} icon={<HiPlus />}>Add entry</Button>
          </div>
        </div>
        {(adding || editing) && <EntryForm entry={editing} onDone={() => { setAdding(false); setEditing(null); load(); }} onCancel={() => { setAdding(false); setEditing(null); }} />}
        {cal && cal.entries.length === 0 ? (
          <div className="panel-body"><p className="side-note">No entries in the next 120 days. Add a closure, a supplier delay or a demand change when you expect one.</p></div>
        ) : cal && (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Dates</th><th>Entry</th><th>Applies to</th><th>Change</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {cal.entries.map(e => (
                  <tr key={e.id}>
                    <td>{dates(e.start_date, e.end_date)}</td>
                    <td><StatusBadge tone={KIND[e.kind].tone}>{KIND[e.kind].label}</StatusBadge> {e.title}
                      {e.status === 'cancelled' && <span style={{ marginLeft: 6 }}><StatusBadge tone="neutral">Cancelled</StatusBadge></span>}</td>
                    <td className="side-note">{scopeText(e)}</td>
                    <td>{e.demand_change_pct != null ? <><strong>{e.demand_change_pct > 0 ? '+' : ''}{e.demand_change_pct}%</strong> <span className="side-note">{e.label_text || 'Assumed by you'}</span></>
                      : e.extra_delay_days != null ? <><strong>+{e.extra_delay_days} day(s)</strong> <span className="side-note">{e.label_text || 'Supplier delay declared by you'}</span></>
                        : e.kind === 'closure' ? <><strong>Closed</strong> <span className="side-note">{e.label_text || 'Closure declared by you'}</span></>
                          : <span className="side-note">{e.label_text || 'Information only'}</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.status === 'active' && (
                      <><Button size="sm" variant="secondary" onClick={() => { setAdding(false); setEditing(e); }}>Edit</Button>{' '}
                        <Button size="sm" variant="secondary" onClick={() => cancel(e, load)}>Cancel</Button></>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <HolidaysPanel cal={cal} settings={settings} onSaved={load} />
    </div>
  );
}

const scopeText = (e) => (e.scope === 'all' ? 'All products' : e.scope === 'category' ? `Category: ${e.scope_category}`
  : e.scope === 'products' ? `${e.scope_product_ids.length} product(s)` : `Supplier #${e.supplier_id}`);

async function cancel(e, done) {
  if (!window.confirm(`Cancel "${e.title}"? Its history is kept.`)) return;
  try { await api.post(`/calendar/entries/${e.id}/cancel`, { version: e.version }); toast.success('Entry cancelled'); done(); }
  catch (err) { toast.error(errorText(err, 'The entry was not cancelled.')); done(); }
}

function CountryPanel({ settings, onSaved }) {
  const [code, setCode] = useState(settings?.country_code || settings?.suggested_country || '');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.put('/calendar/settings', { country_code: code }); toast.success('Country confirmed'); setChanging(false); onSaved(); }
    catch (e) { toast.error(errorText(e, 'The country was not saved.')); }
    finally { setBusy(false); }
  };
  if (!settings) return null;
  const name = (c) => settings.supported.find(s => s.code === c)?.name || c;
  return (
    <Panel>
      <PanelHeader title="Country" subtitle="Decides which holidays are shown. A timezone is not proof of a country, so it is only a suggestion." />
      <div className="panel-body stack">
        {settings.confirmed && !changing ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusBadge tone="success"><HiCheck style={{ verticalAlign: '-2px' }} /> {name(settings.country_code)}</StatusBadge>
            <span className="side-note">Confirmed {new Date(settings.confirmed_at).toLocaleDateString()}</span>
            <Button size="sm" variant="secondary" onClick={() => setChanging(true)}>Change</Button>
          </div>
        ) : (
          <div className="coverage-fields">
            <div><label htmlFor="cal-country" className="label-text">Your country</label>
              <select id="cal-country" className="select-field input-field" value={code} onChange={e => setCode(e.target.value)}>
                <option value="">Choose…</option>
                {settings.supported.map(s => <option key={s.code} value={s.code}>{s.name}{s.code === settings.suggested_country ? ' (suggested from your timezone)' : ''}</option>)}
              </select></div>
            <div style={{ alignSelf: 'end', display: 'flex', gap: 8 }}>
              {changing && <Button variant="secondary" onClick={() => setChanging(false)} disabled={busy}>Cancel</Button>}
              <Button onClick={save} disabled={busy || !code}>{busy ? 'Saving…' : 'Confirm country'}</Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function HolidaysPanel({ cal, settings, onSaved }) {
  const [confirming, setConfirming] = useState(null);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  if (!cal || !settings) return null;
  const confirm = async (h) => {
    setBusy(true);
    try {
      await api.post('/calendar/holidays/confirm', { event_key: h.key, year: h.year, start: date });
      toast.success(`${h.name} date confirmed`); setConfirming(null); onSaved();
    } catch (e) { toast.error(errorText(e, 'The date was not saved.')); }
    finally { setBusy(false); }
  };
  return (
    <Panel>
      <PanelHeader title="Holidays (next 120 days)" subtitle={cal.holiday_note} />
      {!settings.confirmed ? (
        <div className="panel-body"><p className="side-note">Confirm your country above to see its holidays.</p></div>
      ) : cal.holidays.length === 0 ? (
        <div className="panel-body"><p className="side-note">No holidays in the next 120 days.</p></div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Dates</th><th>Holiday</th><th>Status</th><th>Effect on your sales</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {cal.holidays.map(h => (
                <tr key={`${h.key}-${h.year}`}>
                  <td>{dates(h.start, h.end)}{h.possible_dates && <span className="side-note" style={{ display: 'block' }}>possible {dates(h.possible_dates.start, h.possible_dates.end)}</span>}</td>
                  <td>{h.name} <span className="side-note">({h.type})</span></td>
                  <td><StatusBadge tone={HOLIDAY_STATUS[h.status].tone}>{HOLIDAY_STATUS[h.status].label}</StatusBadge></td>
                  <td><StatusBadge tone="neutral">{h.effect_label || 'Effect unknown'}</StatusBadge> <span className="side-note">forecast unchanged</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {confirming === `${h.key}-${h.year}` ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input id={`hc-${h.key}`} aria-label={`Local start date of ${h.name}`} type="date" className="input-field" value={date} onChange={e => setDate(e.target.value)} style={{ maxWidth: 160 }} />
                        <Button size="sm" onClick={() => confirm(h)} disabled={busy || !date}>Save</Button>
                        <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
                      </span>
                    ) : h.recurrence === 'lunar' && (
                      <Button size="sm" variant="secondary" onClick={() => { setConfirming(`${h.key}-${h.year}`); setDate(h.start); }}>
                        {h.status === 'confirmed_by_seller' ? 'Change date' : 'Confirm local date'}</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function EntryForm({ entry, onDone, onCancel }) {
  const editing = Boolean(entry);
  const [f, setF] = useState({
    kind: entry?.kind || 'demand_scenario', title: entry?.title || '', start_date: entry?.start_date || today(),
    end_date: entry?.end_date || plus(today(), 6), scope: entry?.scope && entry.scope !== 'supplier' ? entry.scope : 'all',
    scope_category: entry?.scope_category || '', scope_product_ids: entry?.scope_product_ids || [], supplier_id: entry?.supplier_id || '',
    demand_change_pct: entry?.demand_change_pct ?? '', extra_delay_days: entry?.extra_delay_days ?? '', notes: entry?.notes || '',
  });
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get('/products').then(r => setProducts(r.data.products)).catch(() => setProducts([]));
    api.get('/suppliers').then(r => setSuppliers(r.data.suppliers)).catch(() => setSuppliers([]));
  }, []);
  const set = (p) => setF(x => ({ ...x, ...p }));
  const categories = [...new Set(products.map(p => (p.category || '').trim()).filter(Boolean))].sort();
  const demandKinds = f.kind === 'demand_scenario' || f.kind === 'promotion';
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { kind: f.kind, title: f.title, start_date: f.start_date, end_date: f.end_date, notes: f.notes || null };
    if (demandKinds) {
      body.scope = f.scope;
      if (f.scope === 'category') body.scope_category = f.scope_category;
      if (f.scope === 'products') body.scope_product_ids = f.scope_product_ids.map(Number);
      body.demand_change_pct = f.demand_change_pct === '' ? null : Number(f.demand_change_pct);
    }
    if (f.kind === 'supplier_delay') { body.supplier_id = Number(f.supplier_id); body.extra_delay_days = Number(f.extra_delay_days); }
    try {
      const r = editing ? await api.patch(`/calendar/entries/${entry.id}`, { ...body, kind: undefined, version: entry.version })
        : await api.post('/calendar/entries', body);
      if (r.data.overlapping_demand_changes?.length) toast(r.data.note || 'Another demand change overlaps these dates.', { icon: '⚠️' });
      else toast.success(editing ? 'Entry updated' : 'Entry added');
      onDone();
    } catch (e) { setErr(errorText(e, 'The entry was not saved.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel-body stack" style={{ borderTop: '1px solid var(--border)' }}>
      <p className="side-label">{editing ? `Edit “${entry.title}”` : 'New calendar entry'}</p>
      <div className="coverage-fields">
        <div><label htmlFor="ce-kind" className="label-text">Type</label>
          <select id="ce-kind" className="select-field input-field" value={f.kind} disabled={editing} onChange={e => set({ kind: e.target.value })}>
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <em className="side-note" style={{ fontStyle: 'normal' }}>{KIND[f.kind].help}</em></div>
        <div><label htmlFor="ce-title" className="label-text">Title</label>
          <input id="ce-title" className="input-field" maxLength={160} value={f.title} onChange={e => set({ title: e.target.value })} placeholder={f.kind === 'closure' ? 'e.g. Eid holidays' : f.kind === 'supplier_delay' ? 'e.g. Port strike' : 'e.g. Pre-Eid demand'} /></div>
        <div><label htmlFor="ce-start" className="label-text">From</label>
          <input id="ce-start" type="date" className="input-field" value={f.start_date} onChange={e => set({ start_date: e.target.value })} /></div>
        <div><label htmlFor="ce-end" className="label-text">To (inclusive)</label>
          <input id="ce-end" type="date" className="input-field" value={f.end_date} min={f.start_date} onChange={e => set({ end_date: e.target.value })} /></div>
        {demandKinds && (
          <>
            <div><label htmlFor="ce-scope" className="label-text">Applies to</label>
              <select id="ce-scope" className="select-field input-field" value={f.scope} onChange={e => set({ scope: e.target.value })}>
                <option value="all">All products</option><option value="category">A category</option><option value="products">Chosen products</option>
              </select></div>
            {f.scope === 'category' && (
              <div><label htmlFor="ce-cat" className="label-text">Category</label>
                <select id="ce-cat" className="select-field input-field" value={f.scope_category} onChange={e => set({ scope_category: e.target.value })}>
                  <option value="">Choose…</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select></div>
            )}
            {f.scope === 'products' && (
              <div><label htmlFor="ce-prods" className="label-text">Products (hold Ctrl/⌘ for several)</label>
                <select id="ce-prods" multiple size={5} className="select-field input-field" value={f.scope_product_ids.map(String)}
                  onChange={e => set({ scope_product_ids: [...e.target.selectedOptions].map(o => Number(o.value)) })}>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></div>
            )}
            <div><label htmlFor="ce-pct" className="label-text">Demand change, % {f.kind === 'promotion' ? '(optional)' : ''}</label>
              <input id="ce-pct" type="number" min="-100" max="1000" step="1" className="input-field" value={f.demand_change_pct} onChange={e => set({ demand_change_pct: e.target.value })} placeholder="e.g. 40 or -30" />
              <em className="side-note" style={{ fontStyle: 'normal' }}>Your assumption. Shown as “assumed by you”, never as a prediction.</em></div>
          </>
        )}
        {f.kind === 'supplier_delay' && (
          <>
            <div><label htmlFor="ce-sup" className="label-text">Supplier</label>
              <select id="ce-sup" className="select-field input-field" value={f.supplier_id} onChange={e => set({ supplier_id: e.target.value })}>
                <option value="">Choose…</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
            <div><label htmlFor="ce-delay" className="label-text">Extra days</label>
              <input id="ce-delay" type="number" min="1" max="180" step="1" className="input-field" value={f.extra_delay_days} onChange={e => set({ extra_delay_days: e.target.value })} /></div>
          </>
        )}
        <div><label htmlFor="ce-notes" className="label-text">Notes (optional)</label>
          <input id="ce-notes" className="input-field" maxLength={2000} value={f.notes} onChange={e => set({ notes: e.target.value })} /></div>
      </div>
      {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={save} disabled={busy || !f.title.trim() || !f.start_date || !f.end_date}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add entry'}</Button>
      </div>
    </div>
  );
}

