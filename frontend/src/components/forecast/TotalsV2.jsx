'use client';
// Forecast v2: total demand for the next 7 and 28 days for one product.
// The forecasting experience when the backend has v2 switched on
// (GET /forecast/v2/config). Totals only — no daily breakdown, no accuracy
// figure and no confidence range, because none has been validated. History
// counts only days the seller confirmed as complete.
import { useEffect, useState } from 'react';
import { Panel, PanelHeader } from '../ui/Panel';
import Button from '../ui/Button';
import Meter from '../ui/Meter';
import StatusBadge from '../ui/StatusBadge';
import api from '../../services/api';
import { HiArrowUpTray, HiArrowPath, HiCheckBadge } from 'react-icons/hi2';

const TIER = {
  model: { label: 'Full rule · 180+ days', tone: 'var(--forecast)' },
  average: { label: 'Average-based estimate', tone: 'var(--warning)' },
  insufficient: { label: 'Insufficient history', tone: 'var(--warning)' },
};
const GROUP = { regular: 'regular seller', occasional: 'occasional seller', rare: 'rare seller', dormant: 'no recent sales' };

const fmtDay = (s, year = false) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
});
// Whole units from 10 up; one decimal below, where rounding would hide the estimate.
const fmtUnits = (v) => (v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1));

// null while the server is asked; then true (v2) or false (legacy, the rollback path).
export function useForecastV2Enabled() {
  const [enabled, setEnabled] = useState(null);
  useEffect(() => {
    api.get('/forecast/v2/config').then(r => setEnabled(r.data?.enabled === true)).catch(() => setEnabled(false));
  }, []);
  return enabled;
}

export default function TotalsV2({ productId, productName }) {
  const [state, setState] = useState({ loading: false, data: null, error: null });

  const load = () => {
    if (!productId) return;
    setState({ loading: true, data: null, error: null });
    api.get(`/forecast/v2/${productId}`)
      .then(r => setState({ loading: false, data: r.data, error: null }))
      .catch(e => setState({ loading: false, data: null,
        error: e.response?.data?.message || e.response?.data?.error || 'The totals forecast is unavailable.' }));
  };
  useEffect(load, [productId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { loading, data, error } = state;
  const tier = data?.history?.tier ? TIER[data.history.tier] : null;
  const usable = data?.history?.usable_days ?? 0;
  const needsConfirmation = data?.status === 'needs_confirmation';

  return (
    <Panel tone="var(--forecast)" aria-labelledby="totals-title" aria-busy={loading}>
      <PanelHeader
        title="Total demand ahead"
        titleId="totals-title"
        description={productName ? `${productName} · totals for the 7 and 28 days after your confirmed history` : 'Totals for the next 7 and 28 days'}
      >
        <StatusBadge tone="neutral">Forecast v2 · in review</StatusBadge>
        <Button variant="secondary" size="sm" icon={<HiArrowPath />} onClick={load} disabled={loading}>Refresh</Button>
      </PanelHeader>

      {loading && <div className="loading-block"><span className="spinner" aria-label="Loading totals" /></div>}

      {error && !loading && (
        <div className="status-callout">
          <p className="callout-kicker" style={{ color: 'var(--danger)' }}>Totals unavailable</p>
          <p>{error}</p>
        </div>
      )}

      {data && !loading && data.status === 'no_sales' && (
        <div className="status-callout">
          <h3>No sales recorded for this product yet.</h3>
          <Button href="/upload" icon={<HiArrowUpTray />}>Upload sales</Button>
        </div>
      )}

      {data && !loading && data.history && (
        <div className="totals-grid">
          <div className="totals-main">
            {data.forecasts.length > 0 ? (
              <div className="totals-figures">
                {data.forecasts.map(f => (
                  <div key={f.horizon_days} className="total-block">
                    <p className="total-label">Next {f.horizon_days} days</p>
                    <p className="total-value num">{fmtUnits(f.total_units)}<em>units in total</em></p>
                    <p className="total-dates">{fmtDay(f.start)} – {fmtDay(f.end, true)}</p>
                    <p className="total-method"><span className="dot" style={{ '--tone': tier.tone }} />{f.method_label}</p>
                  </div>
                ))}
              </div>
            ) : needsConfirmation ? (
              <div className="status-callout">
                <p className="callout-kicker" style={{ color: 'var(--warning)' }}>History needs confirmation</p>
                <h3>{data.history.unconfirmed_days} days of sales are recorded, but none are confirmed complete.</h3>
                <p>A day with some sales records can still be missing sales, so only periods you confirm count toward a forecast. Your records stay in your sales data either way.</p>
                <Button href="/upload" icon={<HiCheckBadge />}>Confirm periods on Data Integration</Button>
              </div>
            ) : (
              <div className="status-callout">
                <p className="callout-kicker" style={{ color: 'var(--warning)' }}>More history needed</p>
                <h3>No forecast yet: {usable} of 28 confirmed days.</h3>
                <p>An estimate needs at least 28 consecutive confirmed days; the model-based forecast needs 180.</p>
                <Meter value={usable} max={28} tone="var(--warning)" tall label="Confirmed days of history" />
                <Button href="/upload" icon={<HiArrowUpTray />}>Upload or confirm more history</Button>
              </div>
            )}
          </div>

          <aside className="totals-side" aria-label="History used">
            <div className="history-head">
              <span className="side-label">History used</span>
              <StatusBadge tone={data.history.tier === 'model' ? 'info' : 'warning'}>{needsConfirmation ? 'Not confirmed' : tier.label}</StatusBadge>
            </div>
            <p className="history-days num">{usable}<em>consecutive confirmed days</em></p>
            <Meter value={Math.min(usable, 180)} max={180} tone={tier.tone} label="Confirmed days of history out of 180" />
            <p className="side-note">
              {data.history.first_day ? <>From {fmtDay(data.history.first_day, true)} to {fmtDay(data.history.last_day, true)}. </> : null}
              Only confirmed days count: 28 for an estimate, 180 for the model.
            </p>
            {data.pattern && (
              <p className="side-note">Sold on <strong>{data.pattern.selling_day_percent}%</strong> of the last {data.pattern.window_days} days ({GROUP[data.pattern.group]}).</p>
            )}
            <dl className="history-facts">
              <div><dt>Confirmed</dt><dd className="num">{data.history.confirmed_days}</dd></div>
              <div data-warn={data.history.unconfirmed_days > 0 || undefined}><dt>Not confirmed</dt><dd className="num">{data.history.unconfirmed_days}</dd></div>
              <div><dt>No records</dt><dd className="num">{data.history.missing_days}</dd></div>
            </dl>
            <p className="side-note">Days since the first sale on {fmtDay(data.history.first_sale, true)}.</p>
          </aside>
        </div>
      )}

      {data && !loading && data.notes?.length > 0 && (
        <ul className="totals-notes">
          {data.notes.map((n, i) => <li key={i} data-type={n.type}>{n.text}</li>)}
        </ul>
      )}
    </Panel>
  );
}
