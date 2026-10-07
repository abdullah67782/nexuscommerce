'use client';
// Forecast v2: total demand for the next 7 and 28 days for one product.
// Shown only when the backend has v2 switched on (GET /forecast/v2/config).
// Deliberately separate from the daily chart: totals only — no daily breakdown,
// no accuracy figure and no confidence range, because none has been validated.
import { useEffect, useState } from 'react';
import { Panel, PanelHeader } from '../ui/Panel';
import Button from '../ui/Button';
import Meter from '../ui/Meter';
import StatusBadge from '../ui/StatusBadge';
import api from '../../services/api';
import { HiArrowUpTray, HiArrowPath } from 'react-icons/hi2';

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

export function useForecastV2Enabled() {
  const [enabled, setEnabled] = useState(false);
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

  return (
    <Panel tone="var(--forecast)" aria-labelledby="totals-title" aria-busy={loading}>
      <PanelHeader
        title="Total demand ahead"
        titleId="totals-title"
        description={productName ? `${productName} · totals for the next 7 and 28 days after your latest data` : 'Totals for the next 7 and 28 days'}
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
            ) : (
              <div className="status-callout">
                <p className="callout-kicker" style={{ color: 'var(--warning)' }}>More history needed</p>
                <h3>No forecast yet: {usable} of 28 days.</h3>
                <p>An estimate needs at least 28 complete days in a row; the model-based forecast needs 180.</p>
                <Meter value={usable} max={28} tone="var(--warning)" tall label="Usable days of history" />
                <Button href="/upload" icon={<HiArrowUpTray />}>Upload or confirm more history</Button>
              </div>
            )}
          </div>

          <aside className="totals-side" aria-label="History used">
            <div className="history-head">
              <span className="side-label">History used</span>
              <StatusBadge tone={data.history.tier === 'model' ? 'info' : 'warning'}>{tier.label}</StatusBadge>
            </div>
            <p className="history-days num">{usable}<em>consecutive days</em></p>
            <Meter value={Math.min(usable, 180)} max={180} tone={tier.tone} label="Days of usable history out of 180" />
            <p className="side-note">
              {data.history.first_day ? <>From {fmtDay(data.history.first_day, true)} to {fmtDay(data.history.last_day, true)}. </> : null}
              28 days for an estimate, 180 for the model.
            </p>
            {data.pattern && (
              <p className="side-note">Sold on <strong>{data.pattern.selling_day_percent}%</strong> of the last {data.pattern.window_days} days ({GROUP[data.pattern.group]}).</p>
            )}
            <dl className="history-facts">
              <div><dt>Confirmed days</dt><dd className="num">{data.history.covered_days}</dd></div>
              <div><dt>Recorded days</dt><dd className="num">{data.history.recorded_days}</dd></div>
              <div><dt>Unknown gaps</dt><dd className="num">{data.history.gaps.length}</dd></div>
            </dl>
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
