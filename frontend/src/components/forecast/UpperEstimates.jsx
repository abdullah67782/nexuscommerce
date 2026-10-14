'use client';
// Upper demand estimates (upper-estimates-1): beside the unchanged forecast, an 80% or a 90% ONE-SIDED upper
// estimate for the next 7 and 28 days, with its method, the benchmark coverage and sample counts, and the
// limitations. Never a range (there is no lower estimate), never a guarantee and never an order quantity; the
// reorder suggestions and safety stock do not use it. The server decides applicability (store country, store
// profile, product department, history and sales pattern) and gives the reason when it is unavailable.
import { useEffect, useState, useCallback } from 'react';
import { Panel, PanelHeader } from '../ui/Panel';
import Button from '../ui/Button';
import Segmented from '../ui/Segmented';
import StatusBadge from '../ui/StatusBadge';
import api from '../../services/api';
import { HiCheckCircle, HiXCircle } from 'react-icons/hi2';

const fmtDay = (s, year = false) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
});
const fmtUnits = (v) => (v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1));
const pct = (v) => `${(100 * v).toFixed(1)}%`;
const LEVELS = [{ value: 0.8, label: '80%' }, { value: 0.9, label: '90%' }];
const failed = (e) => ({ loading: false, data: null, settings: null,
  error: e.response?.data?.message || 'Upper estimates are unavailable. Your forecast is not affected.' });
const FIX = {
  country_not_confirmed: 'country', market_pakistan: null, market_not_evaluated: null,
  profile_not_confirmed: 'profile', profile_withdrawn: 'profile', product_type_not_set: 'department', product_type_not_covered: 'department',
};

export default function UpperEstimates({ productId }) {
  const [state, setState] = useState({ loading: true, data: null, settings: null, error: null });
  const [level, setLevel] = useState(0.8);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [dept, setDept] = useState('');
  const [msg, setMsg] = useState(null);

  const request = useCallback(() => Promise.all([api.get(`/forecast/v2/${productId}/upper-estimates`), api.get('/forecast/upper-estimates/settings')]),
    [productId]);
  const apply = useCallback(([r, s]) => {
    setState({ loading: false, data: r.data, settings: s.data, error: null });
    setDept(r.data?.product?.department || '');
  }, []);
  // After a save (event handler): show loading, then refresh.
  const load = () => {
    setState(s => ({ ...s, loading: true, error: null }));
    request().then(apply).catch(e => setState(failed(e)));
  };
  // First load: state is set only in the request's callbacks (react-hooks/set-state-in-effect). The panel is
  // keyed by product on the page, so a new product starts from the initial loading state.
  useEffect(() => {
    let live = true;
    request().then(v => { if (live) apply(v); }).catch(e => { if (live) setState(failed(e)); });
    return () => { live = false; };
  }, [request, apply]);

  const save = async (fn) => {
    setBusy(true); setMsg(null);
    try { await fn(); setAck(false); load(); } catch (e) { setMsg(e.response?.data?.message || 'Could not save.'); } finally { setBusy(false); }
  };
  const confirmProfile = () => save(() => api.put('/forecast/upper-estimates/settings',
    { status: 'confirmed', acknowledge: true, version: state.settings?.version ?? undefined }));
  const withdraw = () => save(() => api.put('/forecast/upper-estimates/settings', { status: 'withdrawn', version: state.settings?.version }));
  const saveDept = () => save(() => api.put(`/forecast/upper-estimates/products/${productId}`,
    { department: dept, version: state.data?.product?.department_version ?? undefined }));

  const { loading, data, settings, error } = state;
  if (data?.reason?.code === 'disabled' && !loading) return null;   // switched off: nothing to show
  const available = data?.status === 'available';
  const fix = data && !available ? FIX[data.reason?.code] : null;
  const byHorizon = available ? [7, 28].map(h => ({
    h, e: data.estimates.find(x => x.horizon_days === h && x.level === level),
    other: data.estimates.find(x => x.horizon_days === h && x.level !== level),
  })).filter(x => x.e) : [];
  const departmentControl = (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <label htmlFor="ue-dept" className="label-text" style={{ margin: 0 }}>Product department</label>
      <select id="ue-dept" className="select-field" style={{ maxWidth: 240 }} value={dept} onChange={e => setDept(e.target.value)}>
        <option value="" disabled>Choose…</option>
        {Object.entries(data?.departments || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <Button size="sm" variant="secondary" onClick={saveDept} disabled={busy || !dept || dept === data?.product?.department}>Save</Button>
    </span>
  );

  return (
    <Panel tone="var(--forecast)" aria-labelledby="ue-title" aria-busy={loading}>
      <PanelHeader title="Upper demand estimate" titleId="ue-title"
        description="How high demand could reasonably go, judged against benchmark data. One-sided: there is no lower estimate.">
        <StatusBadge tone="neutral">Benchmark reference · not calibrated to your store</StatusBadge>
        {available && <Segmented label="Estimate level" options={LEVELS} value={level} onChange={setLevel} />}
      </PanelHeader>

      {loading && <div className="loading-block"><span className="spinner" aria-label="Loading upper estimates" /></div>}
      {error && !loading && <div className="status-callout"><p>{error}</p></div>}

      {data && !loading && available && (
        <div className="totals-figures" style={{ height: 'auto' }}>{/* its own height: 100% is for the totals grid cell */}
          {byHorizon.map(({ h, e, other }) => (
            <div key={h} className="total-block">
              <p className="total-label">Next {h} days · {Math.round(100 * e.level)}% upper estimate</p>
              <p className="total-value num">{fmtUnits(e.upper_units)}<em>units · upper estimate</em></p>
              <p className="total-dates">{fmtDay(e.start)} – {fmtDay(e.end, true)}</p>
              <p className="side-note">Forecast for the same days: <strong>{fmtUnits(e.forecast_units)}</strong> units (unchanged).</p>
              <p className="total-method"><span className="dot" style={{ '--tone': 'var(--forecast)' }} />{e.method_label} ({e.method})</p>
              <p className="side-note">
                In the benchmark, actual demand was at or below this estimate in <strong>{pct(e.benchmark.coverage.value)}</strong> of{' '}
                {e.benchmark.windows.toLocaleString()} windows from {e.benchmark.series} products × stores (target {Math.round(100 * e.level)}%,
                accepted within ±{e.benchmark.tolerance_points ?? 5} points).
              </p>
              {e.upper_units < e.forecast_units && (
                <p className="side-note">The estimate is below the forecast: sales are irregular, and the forecast is an average while this is the level demand stayed at or below in most benchmark windows.</p>
              )}
              {other && (() => {
                const u80 = e.level === 0.8 ? e : other;
                const u90 = e.level === 0.9 ? e : other;
                return u90.upper_units < u80.upper_units ? (
                  <p className="side-note">For this product the 90% estimate ({fmtUnits(u90.upper_units)}) is below the 80% estimate ({fmtUnits(u80.upper_units)}): the two levels use different evaluated methods, and neither is adjusted.</p>
                ) : null;
              })()}
            </div>
          ))}
        </div>
      )}

      {data && !loading && !available && (
        <div className="status-callout">
          <p className="callout-kicker" style={{ color: 'var(--warning)' }}>No upper estimate for this product</p>
          <p>{data.reason?.text}</p>
          {fix === 'country' && <Button href="/inventory?tab=calendar" variant="secondary">Confirm your country</Button>}
          {fix === 'profile' && (
            <div style={{ display: 'grid', gap: 10, justifyItems: 'center', maxWidth: 520 }}>
              <label className="side-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left' }}>
                <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ marginTop: 3 }} />
                <span>{settings?.profile_text}</span>
              </label>
              <Button size="sm" onClick={confirmProfile} disabled={busy || !ack}>Confirm store profile</Button>
            </div>
          )}
          {fix === 'department' && departmentControl}
          {msg && <p style={{ color: 'var(--danger)' }}>{msg}</p>}
        </div>
      )}

      {data && !loading && (
        <div className="totals-notes" style={{ display: 'grid', gap: 10 }}>
          {data.checks?.length > 0 && (
            <ul aria-label="Applicability checks" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
              {data.checks.map(c => (
                <li key={c.code} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {c.ok ? <HiCheckCircle aria-label="met" style={{ color: 'var(--success)' }} /> : <HiXCircle aria-label="not met" style={{ color: 'var(--text-3)' }} />}
                  {c.text}
                </li>
              ))}
            </ul>
          )}
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {(data.limitations || []).map((t, i) => <li key={i} style={i === 0 ? { color: 'var(--text)', fontWeight: 500 } : undefined}>{t}</li>)}
          </ul>
          {available && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {departmentControl}
              <Button size="sm" variant="secondary" onClick={withdraw} disabled={busy}>Withdraw store confirmation</Button>
              {msg && <span style={{ color: 'var(--danger)' }}>{msg}</span>}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
