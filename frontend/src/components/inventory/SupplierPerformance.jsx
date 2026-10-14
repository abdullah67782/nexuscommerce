'use client';
// Supplier intelligence (GET /suppliers/:id/performance): delivery performance from your own orders, timestamp
// quality, declared lead times and delay scenarios, and whether a learned delivery estimate is supported. Reorder
// suggestions always keep the declared lead time; this view never changes orders or stock.
import { useEffect, useState } from 'react';
import StatusBadge from '../ui/StatusBadge';
import Skeleton from '../ui/Skeleton';
import api from '../../services/api';

const ISSUE = {
  receipt_before_order: 'Receipt dated before the order — left out',
  order_backdated: 'Marked ordered later than its order date',
  receipt_recorded_late: 'Receipt recorded more than 2 days after delivery',
  no_promise: 'No expected date',
  promise_revised: 'Expected date changed after ordering',
};
const STATE = {
  delivered: ['success', 'Delivered'], open: ['neutral', 'Open'], open_late: ['warning', 'Open, late'],
  cancelled: ['neutral', 'Cancelled'], cancelled_after_partial: ['neutral', 'Cancelled after part delivery'],
};
const LEARNED = {
  not_enough_history: ['neutral', 'Not enough history'], not_enough_to_evaluate: ['neutral', 'Not enough to check'],
  evaluated_not_better: ['neutral', 'Checked: not better than declared'], learned_available: ['info', 'Observed estimate available'],
};
const days = (n) => (n == null ? '—' : `${n} day${n === 1 ? '' : 's'}`);

export default function SupplierPerformance({ supplierId }) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let live = true;
    api.get(`/suppliers/${supplierId}/performance`)
      .then(r => { if (live) setState({ data: r.data, error: null }); })
      .catch(e => { if (live) setState({ data: null, error: e?.response?.data?.message || 'Delivery performance could not be loaded.' }); });
    return () => { live = false; };
  }, [supplierId]);
  const { data, error } = state;
  if (error) return <p className="side-note" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>;
  if (!data) return <Skeleton height={80} />;
  const p = data.supplier;
  const lt = p.lead_time;
  const learned = LEARNED[p.learned_estimate.state];
  const flagged = Object.entries(p.timestamp_quality.flags).filter(([k]) => k !== 'no_promise' && k !== 'promise_revised');
  return (
    <div className="stack" aria-label="Delivery performance">
      <p className="side-label">Delivery performance <span className="side-note">· from your own orders, as of {data.as_of}</span></p>
      <dl className="history-facts">
        <div><dt>Declared lead time</dt><dd className="num">{lt.declared_days ? (lt.declared_days.min === lt.declared_days.max ? days(lt.declared_days.min) : `${lt.declared_days.min}–${lt.declared_days.max} days`) : '—'}</dd></div>
        <div><dt>Observed (delivered orders)</dt><dd className="num">{lt.observed_orders ? `${days(lt.observed_median_days)} · n=${lt.observed_orders}` : '—'}</dd></div>
        <div data-warn={p.promises.late > 0 || undefined}><dt>On time / judged</dt><dd className="num">{p.promises.judged ? `${p.promises.on_time} / ${p.promises.judged}` : '—'}</dd></div>
      </dl>
      <p className="side-note">
        {p.orders.placed} ordered · {p.orders.delivered} delivered · {p.orders.open} open · {p.orders.open_late} open and late
        {p.orders.cancelled ? ` · ${p.orders.cancelled} cancelled${p.orders.cancelled_after_partial ? ` (${p.orders.cancelled_after_partial} after a partial delivery, not counted as delivered)` : ''}` : ''}{p.orders.excluded_invalid_dates ? ` · ${p.orders.excluded_invalid_dates} left out (impossible dates)` : ''}.
        {' '}{p.promises.note}
      </p>
      <p className="side-note"><StatusBadge tone={learned[0]}>{learned[1]}</StatusBadge> {p.learned_estimate.text}</p>
      <p className="side-note">
        Delay scenarios: {p.delay_scenarios.declared_slowest_days != null ? `declared slowest ${days(p.delay_scenarios.declared_slowest_days)}` : 'no declared slowest time'}
        {p.delay_scenarios.calendar_delays.length
          ? `; calendar delays ${p.delay_scenarios.calendar_delays.map(d => `“${d.title}” +${d.extra_delay_days} (${d.start_date} to ${d.end_date})`).join(', ')}`
          : '; no supplier delay on the calendar'}. <span className="side-note">Declared by you.</span>
      </p>
      {flagged.length > 0 && (
        <p className="side-note">Date quality: {flagged.map(([k, n]) => `${ISSUE[k]} (${n})`).join('; ')}.</p>
      )}
      {p.order_detail.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr>{['Order', 'Ordered', 'Promised', 'Delivered', 'Lead time', 'Status', 'Notes'].map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {[...p.order_detail].reverse().slice(0, 12).map(o => (
                <tr key={o.po_id} className={o.valid ? '' : 'is-muted'}>
                  <td className="is-mono">PO-{o.po_id}</td>
                  <td className="is-mono">{o.ordered_day}</td>
                  <td className="is-mono">{o.promised_day || '—'}</td>
                  <td className="is-mono">{o.delivered_day || (o.first_receipt_day ? `part ${o.first_receipt_day}` : '—')}</td>
                  <td>{o.lead_days != null ? days(o.lead_days) : o.open_days_so_far != null ? `${days(o.open_days_so_far)} so far` : '—'}</td>
                  <td><StatusBadge tone={STATE[o.state][0]}>{STATE[o.state][1]}</StatusBadge></td>
                  <td className="side-note">{o.issues.map(i => ISSUE[i]).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
