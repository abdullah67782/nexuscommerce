'use client';
// Stage 2 product outlook: the replenishment result for one product, with its
// numbers, assumptions, limitations and missing information, a scenario panel
// (never saved) and — only for a provisional suggestion — "Create draft order".
// Advisory only: nothing here changes stock, settings or an existing order.
import { useState, useEffect, useCallback } from 'react';
import Button from '../ui/Button';
import StatusBadge from '../ui/StatusBadge';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { HiExclamationTriangle, HiArrowPath, HiDocumentPlus, HiBeaker } from 'react-icons/hi2';

export const REC_STATUS = {
  provisional: { tone: 'info', label: 'Provisional' },
  indicative: { tone: 'warning', label: 'Indicative only' },
  needs_information: { tone: 'neutral', label: 'Needs information' },
  unavailable: { tone: 'critical', label: 'Forecast unavailable' },
};
export const METHOD = { shared_model: 'Shared model', tsb: 'Rare-sales method (TSB)', average_28: '28-day average' };
const errorText = (e, fallback) => e?.response?.data?.message || e?.response?.data?.error || fallback;
const n1 = (x) => (x == null ? '—' : Number.isInteger(x) ? x.toLocaleString() : (Math.round(x * 10) / 10).toFixed(1));
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const unitsOf = (q) => `${fmtNum(q)} unit${q === 1 ? '' : 's'}`;

export default function OutlookPanel({ productId, onChanged, onAction }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData((await api.get(`/inventory/items/${productId}/replenishment`)).data); setError(null); }
    catch (e) { setError(errorText(e, 'The outlook could not be computed.')); }
    finally { setLoading(false); }
  }, [productId]);
  // First load: state is set only in the request's callbacks (react-hooks/set-state-in-effect). The panel is
  // keyed by product in the parent, so a new product starts from the initial loading state.
  useEffect(() => {
    let live = true;
    api.get(`/inventory/items/${productId}/replenishment`)
      .then(r => { if (live) { setData(r.data); setError(null); } })
      .catch(e => { if (live) setError(errorText(e, 'The outlook could not be computed.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [productId]);

  const createDraft = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await api.post('/purchase-orders/from-recommendation', { recommendation_id: data.recommendation_id, inputs_sha256: data.inputs_sha256 });
      toast.success(r.data.replayed ? `Draft PO-${r.data.purchase_order.id} already exists` : `Draft PO-${r.data.purchase_order.id} created — review and approve it on Purchase orders`);
      await load(); onChanged?.();
    } catch (e) {
      const body = e?.response?.data;
      if (body?.error === 'recommendation_stale' && body.current) {
        setData(body.current);
        setNotice(body.message);
        onChanged?.();              // the stock figures above the outlook are reloaded too
      } else toast.error(errorText(e, 'The draft was not created.'));
    } finally { setBusy(false); }
  };

  if (error && !data) {
    return <EmptyState icon={<HiExclamationTriangle />} title="Outlook could not be loaded" action={<Button variant="secondary" size="sm" onClick={load}>Retry</Button>}>{error}</EmptyState>;
  }
  if (!data) return <div className="stack"><Skeleton height={90} /><Skeleton height={140} /></div>;
  const r = data;
  const st = REC_STATUS[r.status] || REC_STATUS.needs_information;
  return (
    <div className="stack outlook">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
          <span className="side-note">Planning from {r.planning_date} ({r.timezone}) · {r.engine_version}</span>
        </span>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading} icon={<HiArrowPath className={loading ? 'spin' : ''} />}>Recompute</Button>
      </div>
      {notice && <p className="side-note" role="alert" style={{ color: 'var(--warning)' }}><HiExclamationTriangle style={{ verticalAlign: '-2px' }} /> {notice} The result below is the recomputed one.</p>}
      {r.status === 'unavailable' && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>The forecast service is not available ({r.forecast?.message}). No demand figures are shown, and nothing older is used instead.</p>}

      <ResultBody r={r} onAction={onAction} />

      {r.actionable && !r.draft_order && (
        <div className="outlook-cta">
          <Button onClick={createDraft} disabled={busy} icon={<HiDocumentPlus />}>{busy ? 'Checking…' : `Create draft order for ${fmtNum(r.suggestion.quantity)}`}</Button>
          <span className="side-note">Creates a draft only. The inputs are checked again first; nothing is approved or sent.</span>
        </div>
      )}
      {r.draft_order && <p className="side-note">Draft <strong>PO-{r.draft_order.id}</strong> was created from this recommendation ({r.draft_order.status}). <a href="/inventory?tab=orders">Open purchase orders</a></p>}
      {!r.actionable && r.draft_blocked && <p className="side-note">No draft button: {r.draft_blocked.text} <a href="/inventory?tab=orders">Open purchase orders</a></p>}
      {!r.actionable && !r.draft_blocked && r.suggestion && r.suggestion.quantity > 0 && <p className="side-note">No draft button: this suggestion is not actionable until the items above are resolved.</p>}

      <ScenarioPanel productId={productId} base={r} />
    </div>
  );
}

function Horizon({ o, title }) {
  if (!o || !o.covered_days) return <div><span>{title}</span><strong>—</strong><em className="side-note" style={{ fontStyle: 'normal' }}>not covered by the forecast</em></div>;
  return (
    <div>
      <span>{o.complete ? title : `${title} · ${o.label}`}</span>
      <strong style={{ fontSize: 16 }}>{n1(o.demand)} demand</strong>
      <em className="side-note" style={{ fontStyle: 'normal', display: 'block' }}>{o.start} to {o.end}{o.estimate_from ? ` · from the ${o.estimate_from === '7_day_forecast' ? '7' : '28'}-day forecast only` : ''}</em>
      {o.stock_at_end !== undefined && (
        <em className="side-note" style={{ fontStyle: 'normal', display: 'block', color: o.runs_short ? 'var(--danger)' : undefined }}>
          stock at end ≈ {n1(o.stock_at_end)}{o.runs_short ? ` · ≈ ${n1(o.shortage_units)} short` : ' · no shortage'}
        </em>
      )}
    </div>
  );
}

export function ResultBody({ r, onAction, compact = false }) {
  const s = r.suggestion;
  const o = r.outlook;
  const f = r.forecast;
  return (
    <>
      {r.warnings.length > 0 && (
        <ul className="outlook-warnings">{r.warnings.map((w, i) => <li key={i}><HiExclamationTriangle style={{ color: 'var(--warning)', verticalAlign: '-2px' }} /> {w.text}</li>)}</ul>
      )}
      {o && (
        <div className="detail-grid">
          <Horizon o={o[7]} title="Next 7 days" />
          <Horizon o={o[28]} title="Next 28 days" />
          <div><span>Days of cover (approx.)</span><strong style={{ fontSize: 16 }}>{o.approximate_cover_days != null ? `≈ ${o.approximate_cover_days}` : '—'}</strong><em className="side-note" style={{ fontStyle: 'normal' }}>{o.approximate_cover_days != null ? 'under A1 — not a date' : o.cover_note}</em></div>
          <div><span>Before a new order arrives</span>{r.before_arrival
            ? <><strong style={{ fontSize: 16, color: r.before_arrival.runs_short ? 'var(--danger)' : undefined }}>{r.before_arrival.runs_short ? `≈ ${n1(r.before_arrival.shortage_units)} short` : 'no shortage'}</strong><em className="side-note" style={{ fontStyle: 'normal' }}>usable from {r.before_arrival.order_usable_from}</em></>
            : <><strong>—</strong><em className="side-note" style={{ fontStyle: 'normal' }}>needs the lead time</em></>}</div>
        </div>
      )}
      {!o && r.outlook_withheld && <p className="side-note"><HiExclamationTriangle style={{ color: 'var(--warning)', verticalAlign: '-2px' }} /> {r.outlook_withheld.text}</p>}

      {s ? (
        <div className={`order-breakdown${s.indicative_only ? ' is-indicative' : ''}`}>
          <div className="order-breakdown-head">
            <strong>Suggested order: {fmtNum(s.quantity)}</strong>
            {s.indicative_only && <StatusBadge tone="warning">Indicative — not actionable</StatusBadge>}
          </div>
          <ol className="order-steps">
            <li>Needed so no day of the {s.window.days}-day window ({s.window.start} to {s.window.end}) runs short{r.policy.safety_stock_units ? ` and ${r.policy.safety_stock_units} remain at its end` : ''}: <strong>{n1(s.raw_need)}</strong> → whole units <strong>{fmtNum(s.raw_units)}</strong></li>
            {s.raw_units > 0 && <li>Supplier minimum: {s.minimum_adjustment ? <strong>+{fmtNum(s.minimum_adjustment)}</strong> : '+0'} → {fmtNum(s.after_minimum)}</li>}
            {s.raw_units > 0 && <li>Packs of {r.supplier.pack_size || 1}: {s.pack_adjustment ? <strong>+{fmtNum(s.pack_adjustment)}</strong> : '+0'} → <strong>{fmtNum(s.quantity)}</strong>{s.cost ? ` · ${s.cost.currency} ${Number(s.cost.amount).toLocaleString()}` : r.supplier.unit_cost == null ? ' · cost not set' : ''}</li>}
          </ol>
          {s.quantity > 0 && (
            <p className="side-note">With this order: no shortage in the window, lowest stock ≈ {n1(s.after_order.lowest_stock_in_window)}, ≈ {n1(s.after_order.stock_at_window_end)} at its end
              {s.after_order.outlook[28].covered_days ? `; ≈ ${n1(s.after_order.outlook[28].stock_at_end)} after ${s.after_order.outlook[28].label}` : ''}.
              {s.after_order.shortage_before_usable > 0 ? ` The ≈ ${n1(s.after_order.shortage_before_usable)} short before it arrives is not changed by this order.` : ''}</p>
          )}
          {r.alternative_if_uncertain_incoming_arrives && <p className="side-note">{r.alternative_if_uncertain_incoming_arrives.label}: {fmtNum(r.alternative_if_uncertain_incoming_arrives.quantity)}. The suggestion above does not assume they arrive.</p>}
          {r.sales_adjusted_scenario && <p className="side-note">{r.sales_adjusted_scenario.label} (start {fmtNum(r.sales_adjusted_scenario.starting_stock)}): {fmtNum(r.sales_adjusted_scenario.quantity)}. Scenario only — measured stock is unchanged.</p>}
        </div>
      ) : r.suggestion_withheld ? (
        <p className="side-note"><strong>No order quantity.</strong> {r.suggestion_withheld.text}</p>
      ) : null}
      {r.calendar && <CalendarNotes c={r.calendar} />}

      {r.missing.length > 0 && (
        <div>
          <p className="label-text">Missing information</p>
          <ul className="outlook-missing">
            {r.missing.map(m => (
              <li key={m.code}><span>{m.message}</span>
                {onAction && actionFor(m.code) ? <Button variant="secondary" size="sm" onClick={() => onAction(actionFor(m.code))}>{m.action}</Button>
                  : <span className="side-note"> → {m.action}</span>}</li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (
        <>
          {f && f.status === 'ok' && (
            <p className="side-note">Forecast: {METHOD[f.method] || f.method}{f.models_release ? ` (release ${f.models_release})` : ''}, {n1(f.totals[7])} for {f.blocks[0].start} to {f.blocks[0].end} and {n1(f.totals[28])} for {f.blocks[1].start} to {f.blocks[1].end}
              {f.lag_days == null ? ` · dates in the sales timezone (${f.dates_timezone})` : f.lag_days > 0 ? ` · started ${f.lag_days} day(s) before today` : f.lag_days < 0 ? ' · starts after today' : ' · starts today'}.</p>
          )}
          <Incoming r={r} />
          {r.assumptions.length > 0 && (
            <div className="assumption-chips" aria-label="Assumptions">
              {r.assumptions.map(a => <span key={a.code} title={a.text}><StatusBadge tone="neutral">{a.code}</StatusBadge></span>)}
              <details><summary className="side-note">What the assumptions mean</summary>
                <ul className="outlook-list">{r.assumptions.map(a => <li key={a.code}><strong>{a.code}</strong> {a.text}</li>)}</ul></details>
            </div>
          )}
          {r.limitations.length > 0 && <ul className="outlook-list">{r.limitations.map(l => <li key={l.code} className="side-note">{l.text}</li>)}</ul>}
          {r.sales_since_count?.unresolved?.length > 0 && <ul className="outlook-list">{r.sales_since_count.unresolved.map((u, i) => <li key={i} className="side-note">{u.text}</li>)}</ul>}
          {r.explanation?.length > 0 && (
            <details className="outlook-explain"><summary className="label-text">How this was worked out</summary>
              <ol>{r.explanation.map(e => <li key={e.step}><strong>{e.title}.</strong> {e.text}</li>)}</ol></details>
          )}
        </>
      )}
    </>
  );
}

// Store calendar (replenishment-2): what the seller entered and what it changed. Holidays never change demand.
function CalendarNotes({ c }) {
  const demand = c.applied.filter(x => x.effect === 'demand_change');
  const closures = c.applied.filter(x => x.effect === 'closure');
  const nothing = !demand.length && !closures.length && !c.supplier_delay && !c.late_delivery_scenario && !c.order_by && !c.holidays.length;
  return (
    <div className="calendar-notes">
      <p className="label-text">Calendar</p>
      <ul className="outlook-list">
        {demand.map(x => <li key={`d${x.id}`}><StatusBadge tone="info">Assumed by you</StatusBadge> “{x.title}”: demand {x.demand_change_pct > 0 ? '+' : ''}{x.demand_change_pct}% on {x.planning_days} day(s), {x.start_date} to {x.end_date}. Not a prediction.</li>)}
        {c.quantity_without_seller_scenarios && <li className="side-note">{c.quantity_without_seller_scenarios.label}: {fmtNum(c.quantity_without_seller_scenarios.quantity)}.</li>}
        {closures.map(x => <li key={`c${x.id}`}><StatusBadge tone="neutral">Closure declared by you</StatusBadge> “{x.title}” {x.start_date} to {x.end_date}: no sales, deliveries usable from the next open day.</li>)}
        {c.supplier_delay && <li><StatusBadge tone="warning">Supplier delay declared by you</StatusBadge> {c.supplier_delay.text}</li>}
        {c.late_delivery_scenario && <li className="side-note">{c.late_delivery_scenario.label}: {c.late_delivery_scenario.withheld
          || `usable from ${c.late_delivery_scenario.usable_from}, ≈ ${n1(c.late_delivery_scenario.shortage_before_usable)} short before then, quantity ${fmtNum(c.late_delivery_scenario.quantity)}.`}</li>}
        {c.order_by && <li>{c.order_by.text}</li>}
        {c.holidays.length > 0 && <li className="side-note">Holidays: {c.holidays.map(h => `${h.name} ${h.start}${h.status === 'expected' ? ' (expected)' : ''}`).join('; ')}. <StatusBadge tone="neutral">{c.holiday_effect_label || 'Effect unknown'}</StatusBadge> The forecast is not changed for them.</li>}
        {!c.country_confirmed && <li className="side-note">{c.holiday_note}</li>}
        {nothing && c.country_confirmed && <li className="side-note">Nothing you entered affects this product in the next 28 days.</li>}
      </ul>
    </div>
  );
}

const actionFor = (code) => (code.startsWith('stock_') ? 'count' : code === 'horizon_beyond_forecast' ? 'policy'
  : code.startsWith('supplier') || code === 'lead_time_missing' ? 'suppliers' : null);

function Incoming({ r }) {
  const inc = r.incoming;
  const parts = [];
  if (inc.scheduled.length) parts.push(`Counted: ${inc.scheduled.map(x => `PO-${x.po_id}: ${unitsOf(x.quantity)}, usable from ${x.usable_from}`).join(', ')}`);
  if (inc.overdue.length) parts.push(`Not counted — overdue: ${inc.overdue.map(x => `PO-${x.po_id}: ${unitsOf(x.quantity)}`).join(', ')}`);
  if (inc.undated.length) parts.push(`Not counted — no date: ${inc.undated.map(x => `PO-${x.po_id}: ${unitsOf(x.quantity)}`).join(', ')}`);
  if (inc.approved_not_sent.length) parts.push(`Not counted — approved, not ordered: ${inc.approved_not_sent.map(x => `PO-${x.po_id}: ${unitsOf(x.quantity)}`).join(', ')}`);
  if (inc.drafts.length) parts.push(`Not counted — draft: ${inc.drafts.map(x => `PO-${x.po_id}: ${unitsOf(x.quantity)}`).join(', ')}`);
  return <p className="side-note"><strong>Incoming:</strong> {parts.length ? parts.join(' · ') : 'no open purchase orders'}.</p>;
}

function ScenarioPanel({ productId, base }) {
  const [form, setForm] = useState({ review: '', safety: '', lead: '', uncertain: false, delay: '', demand: '' });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {};
      if (form.review !== '') body.review_period_days = Number(form.review);
      if (form.safety !== '') body.safety_stock_units = Number(form.safety);
      if (form.lead !== '') body.lead_time_days = Number(form.lead);
      if (form.uncertain) body.include_uncertain_incoming = true;
      if (form.delay !== '') body.extra_delay_days = Number(form.delay);
      if (form.demand !== '') body.demand_change_pct = Number(form.demand);
      setRes((await api.post(`/inventory/items/${productId}/replenishment/scenario`, body)).data);
    } catch (e) { setErr(errorText(e, 'The scenario could not be computed.')); setRes(null); }
    finally { setBusy(false); }
  };
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const empty = form.review === '' && form.safety === '' && form.lead === '' && !form.uncertain && form.delay === '' && form.demand === '';
  return (
    <details className="scenario-panel">
      <summary className="label-text"><HiBeaker style={{ verticalAlign: '-2px' }} /> Try a scenario (not saved)</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <div className="coverage-fields">
          <div><label htmlFor="sc-review" className="label-text">Review period (days)</label>
            <input id="sc-review" type="number" min="1" max="28" className="input-field" value={form.review} onChange={set('review')} placeholder={String(base.policy.review_period_days)} /></div>
          <div><label htmlFor="sc-safety" className="label-text">Safety stock (units)</label>
            <input id="sc-safety" type="number" min="0" className="input-field" value={form.safety} onChange={set('safety')} placeholder={String(base.policy.safety_stock_units)} /></div>
          <div><label htmlFor="sc-lead" className="label-text">Lead time (days)</label>
            <input id="sc-lead" type="number" min="0" max="365" className="input-field" value={form.lead} onChange={set('lead')} placeholder={base.supplier.lead_time_days != null ? String(base.supplier.lead_time_days) : 'not set'} /></div>
          {base.calendar && (
            <>
              <div><label htmlFor="sc-delay" className="label-text">Supplier delay (extra days)</label>
                <input id="sc-delay" type="number" min="1" max="180" className="input-field" value={form.delay} onChange={set('delay')} placeholder="none" /></div>
              <div><label htmlFor="sc-demand" className="label-text">Demand change, % (your assumption)</label>
                <input id="sc-demand" type="number" min="-100" max="1000" className="input-field" value={form.demand} onChange={set('demand')} placeholder="none" /></div>
            </>
          )}
        </div>
        <label className="side-note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={form.uncertain} onChange={set('uncertain')} /> Treat overdue and undated deliveries as arriving today
        </label>
        {err && <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="secondary" size="sm" onClick={run} disabled={busy || empty}>{busy ? 'Computing…' : 'Run scenario'}</Button>
          {res && <Button variant="secondary" size="sm" onClick={() => { setRes(null); setForm({ review: '', safety: '', lead: '', uncertain: false, delay: '', demand: '' }); }}>Clear</Button>}
        </div>
        {res && (
          <div className="scenario-result" aria-live="polite">
            <p className="label-text">{res.label}: <StatusBadge tone={(REC_STATUS[res.status] || REC_STATUS.needs_information).tone}>{(REC_STATUS[res.status] || REC_STATUS.needs_information).label}</StatusBadge></p>
            <ResultBody r={res} compact />
            <p className="side-note">Your settings and the saved recommendation are unchanged. A scenario cannot create a draft.</p>
          </div>
        )}
      </div>
    </details>
  );
}
