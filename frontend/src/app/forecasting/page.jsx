'use client';
import { useState, useEffect, useRef } from 'react';
import ProtectedRoute from '../../components/ProtectedRoute';
import PageHeader from '../../components/PageHeader';
import ChartTooltip from '../../components/ChartTooltip';
import { Panel, PanelHeader } from '../../components/ui/Panel';
import Button from '../../components/ui/Button';
import StatusBadge from '../../components/ui/StatusBadge';
import Skeleton from '../../components/ui/Skeleton';
import Segmented from '../../components/ui/Segmented';
import Gauge from '../../components/ui/Gauge';
import Meter from '../../components/ui/Meter';
import EmptyState from '../../components/ui/EmptyState';
import HatchDefs from '../../components/charts/HatchDefs';
import { C, axisProps, gridProps, cursorProps } from '../../components/charts/chartTheme';
import api from '../../services/api';
import TotalsV2, { useForecastV2Enabled } from '../../components/forecast/TotalsV2';
import toast from 'react-hot-toast';
import {
  HiChartBar, HiArrowDownTray, HiSparkles, HiArrowPath, HiArrowUpTray,
  HiCheckCircle, HiXCircle, HiBoltSlash, HiBolt,
} from 'react-icons/hi2';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

// ─── Constants ────────────────────────────────────────────────────────────────

const FEATURE_LABELS = {
  lag_1: "Yesterday's sales",
  lag_7: "Last week's sales",
  lag_14: '2 weeks ago sales',
  lag_28: "Last month's sales",
  roll_mean_7: '7-day sales average',
  roll_mean_14: '14-day average',
  roll_mean_28: 'Monthly average',
  ewm_7: 'Recent sales trend',
  ewm_14: 'Bi-weekly trend',
  ewm_28: 'Monthly trend',
  day_of_week: 'Day of week pattern',
  is_weekend: 'Weekend effect',
  month: 'Seasonal pattern',
  trend_7: 'Week-over-week change',
  trend_14: '2-week momentum',
  dow_sin: 'Weekly cycle',
  month_sin: 'Seasonal cycle',
  quarter: 'Quarterly pattern',
};
const label = f => FEATURE_LABELS[f] || f.replace(/_/g, ' ');
const fmtDate = s => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
const fmtDateLong = s => s ? new Date(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

// ─── Accuracy helpers (value is always computed server-side; null → "—") ─────
const accTone = a => (a == null ? 'var(--subtle)' : a >= 85 ? 'var(--success)' : a >= 70 ? 'var(--warning)' : 'var(--danger)');
const accSubLabel = a => {
  if (a == null) return 'Accuracy computed from your data';
  if (a >= 70) return 'accuracy on your sales data';
  if (a >= 40) return 'accuracy — fine-tune to improve';
  return 'Base model not calibrated — fine-tune your model below';
};

// ─── Page: v2 when the server enables it, otherwise the legacy daily forecast ─
// The legacy implementation below is kept unchanged for rollback
// (FORECAST_V2_ENABLED unset). With v2 on, none of its daily predictions,
// accuracy gauge, 95% ranges, horizon controls or exports are shown.
export default function ForecastingPage() {
  const v2Enabled = useForecastV2Enabled();
  if (v2Enabled === null) {
    return (
      <ProtectedRoute>
        <div className="page"><Skeleton height={120} /></div>
      </ProtectedRoute>
    );
  }
  return v2Enabled ? <ForecastingV2Page /> : <LegacyForecastingPage />;
}

function ForecastingV2Page() {
  const [products, setProducts] = useState([]);
  const [prodLoading, setProdLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState('');

  useEffect(() => {
    api.get('/products').then(r => {
      const p = r.data?.products || [];
      setProducts(p);
      if (p.length) setSelectedProduct(p[0].id.toString());
    }).catch(() => setProducts([])).finally(() => setProdLoading(false));
  }, []);

  return (
    <ProtectedRoute>
      <div className="page">
        <PageHeader
          title="Demand Forecasting"
          description="Total units each product is likely to sell over the next 7 and 28 days, built only from sales history you confirmed as complete."
        />
        <Panel aria-label="Forecast product">
          <div className="controls controls-single">
            <div>
              <label htmlFor="forecast-product" className="label-text">Product</label>
              <select id="forecast-product" value={selectedProduct} onChange={e => setSelectedProduct(e.target.value)} disabled={prodLoading} className="select-field">
                <option value="" disabled>{prodLoading ? 'Loading products…' : 'Select product…'}</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
        </Panel>
        {selectedProduct ? (
          <TotalsV2 productId={selectedProduct} productName={products.find(p => String(p.id) === selectedProduct)?.name} />
        ) : !prodLoading && (
          <Panel variant="subtle">
            <EmptyState icon={<HiChartBar />} title="No products yet">Upload sales on Data Integration to see forecasts here.</EmptyState>
          </Panel>
        )}
      </div>
    </ProtectedRoute>
  );
}

function LegacyForecastingPage() {
  // ── Product / forecast state ───────────────────────────────────────────────
  const [products, setProducts] = useState([]);
  const [prodLoading, setProdLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState('');
  const [period, setPeriod] = useState(30);
  const [loading, setLoading] = useState(false);
  const [forecastData, setForecastData] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [features, setFeatures] = useState(null);
  const [modelUsed, setModelUsed] = useState(null);
  const [insufficientHistory, setInsufficientHistory] = useState(null);
  const [error, setError] = useState(null);

  // ── Forecast vs Actual state ──────────────────────────────────────────────
  const [comparison, setComparison] = useState(null);

  // ── Fine-tune state ───────────────────────────────────────────────────────
  // ftState: 'loading' | 'idle' | 'training' | 'completed' | 'has_model' | 'failed'
  const [ftState, setFtState] = useState('loading');
  const [ftAccuracy, setFtAccuracy] = useState(null);
  const [ftLastTrained, setFtLastTrained] = useState(null);
  const [ftError, setFtError] = useState(null);
  const [ftStarting, setFtStarting] = useState(false);
  // Training is controlled by the server and is off unless it says otherwise.
  const [trainingEnabled, setTrainingEnabled] = useState(false);
  const pollingRef = useRef(null);

  // ── Bar animation state ───────────────────────────────────────────────────
  const [barsVisible, setBarsVisible] = useState(false);

  // ─── On mount: load products + finetune status ────────────────────────────
  useEffect(() => {
    api.get('/products').then(r => {
      const p = r.data?.products || [];
      setProducts(p);
      if (p.length) setSelectedProduct(p[0].id.toString());
    }).catch(() => {
      setProducts([{ id: 1, name: 'Sample Product A' }, { id: 2, name: 'Sample Product B' }]);
      setSelectedProduct('1');
    }).finally(() => setProdLoading(false));

    loadFtStatus();
  }, []);

  // ─── Animate feature bars when features load ──────────────────────────────
  useEffect(() => {
    if (features) {
      setBarsVisible(false);
      setTimeout(() => setBarsVisible(true), 50);
    }
  }, [features]);

  // ─── Poll fine-tune status while training ─────────────────────────────────
  useEffect(() => {
    if (ftState !== 'training') {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      return;
    }
    pollingRef.current = setInterval(async () => {
      try {
        const r = await api.get('/finetune/status');
        if (r.data.status === 'completed') {
          clearInterval(pollingRef.current);
          setFtState('completed');
          setTimeout(() => setFtState('has_model'), 4000);
        } else if (r.data.status === 'failed') {
          clearInterval(pollingRef.current);
          setFtError(r.data.error_message || 'Training failed. Please try again.');
          setFtState('failed');
        }
      } catch (_) {}
    }, 3000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [ftState]);

  // ─── Load metrics when model is available ─────────────────────────────────
  useEffect(() => {
    if (ftState === 'has_model' || ftState === 'completed') {
      api.get('/forecast/metrics').then(r => {
        setFtAccuracy(r.data.accuracy ?? null);
        setFtLastTrained(r.data.last_trained ?? null);
      }).catch(() => {});
    }
  }, [ftState]);

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const loadFtStatus = async () => {
    try {
      const r = await api.get('/finetune/status');
      setTrainingEnabled(r.data.training_enabled === true);
      if (r.data.status === 'running') setFtState('training');
      else if (r.data.has_finetuned_model) setFtState('has_model');
      else setFtState('idle');
    } catch (_) {
      setFtState('idle');
    }
  };

  const startFinetune = async () => {
    setFtStarting(true);
    try {
      await api.post('/finetune', {});
      setFtState('training');
      toast.success('Training started — this takes 2-3 minutes');
    } catch (e) {
      if (e.response?.status === 403) setTrainingEnabled(false);
      toast.error(e.response?.data?.message || e.response?.data?.error || 'Failed to start training');
    } finally {
      setFtStarting(false);
    }
  };

  const mockData = () => {
    const today = new Date();
    const pts = Array.from({ length: period }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() + i + 1);
      const base = 100 + Math.random() * 50;
      return {
        date: d.toISOString().split('T')[0],
        day: d.toLocaleDateString('en-US', { weekday: 'short' }),
        demand: Math.round(base),
        lower: Math.round(base * 0.85),
        upper: Math.round(base * 1.15),
      };
    });
    const avg = Math.round(pts.reduce((s, p) => s + p.demand, 0) / period);
    const peak = [...pts].sort((a, b) => b.demand - a.demand)[0];
    setForecastData({ summary: { avg, peak_day: peak.date, peak_val: peak.demand, total: avg * period }, points: pts });
    setAccuracy(null);
    setModelUsed('xgboost_base');
    setFeatures({ lag_7: 0.35, roll_mean_14: 0.25, day_of_week: 0.15, ewm_7: 0.12, month: 0.08 });
    setComparison({ comparison: [], avg_accuracy: null });
  };

  const generate = async () => {
    if (!selectedProduct) { toast.error('Select a product first'); return; }
    setLoading(true);
    setError(null);
    setForecastData(null);
    setAccuracy(null);
    setInsufficientHistory(null);
    setComparison(null);
    try {
      const r = await api.get(`/forecast/${selectedProduct}`, { params: { period } });
      setForecastData(r.data.forecast);
      setAccuracy(r.data.accuracy ?? null);
      setModelUsed(r.data.model_used);
      const fi = r.data.feature_importance;
      if (Array.isArray(fi) && fi.length) {
        const obj = {}; fi.forEach(f => { obj[f.feature] = f.importance; }); setFeatures(obj);
      } else { setFeatures(fi || null); }
      toast.success('Forecast generated');

      // Load comparison in background
      api.get(`/forecast/${selectedProduct}/accuracy`).then(r2 => {
        setComparison(r2.data);
      }).catch(() => setComparison({ comparison: [], avg_accuracy: null }));
    } catch (err) {
      if (err.response?.status === 422 && err.response?.data?.error === 'insufficient_history') {
        setInsufficientHistory({
          days_available: err.response.data.days_available,
          days_needed: err.response.data.days_needed,
        });
      } else if (!err.response || err.response.status >= 500 || err.code === 'ERR_NETWORK') {
        toast.success('Using demo data (backend offline)');
        mockData();
      } else {
        setError('Failed to generate forecast. Please try again.');
        toast.error('Forecast failed');
      }
    } finally { setLoading(false); }
  };

  const exportCSV = () => {
    if (!forecastData?.points) return;
    const rows = forecastData.points.map(p => `${p.date},${p.day},${p.demand},${p.lower},${p.upper},95%`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Date,Day,Demand,Lower,Upper,Confidence\n${rows}`], { type: 'text/csv' }));
    a.download = `forecast_p${selectedProduct}_${period}d.csv`;
    a.click();
    toast.success('CSV exported');
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  const isPersonal = modelUsed === 'xgboost_finetuned';

  return (
    <ProtectedRoute>
      <div className="page">
        <PageHeader
          title="Demand Forecasting"
          description="See how much of each product you are likely to sell, the range around it, and what drives it."
          meta={<ModelStatus ftState={ftState} ftAccuracy={ftAccuracy} ftLastTrained={ftLastTrained} />}
        >
          {ftState === 'has_model' && trainingEnabled && <Button variant="secondary" onClick={() => setFtState('idle')} icon={<HiArrowPath />}>Retrain model</Button>}
        </PageHeader>

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <Panel aria-label="Forecast controls">
          <div className="controls">
            <div>
              <label htmlFor="forecast-product" className="label-text">Product</label>
              <select id="forecast-product" value={selectedProduct} onChange={e => setSelectedProduct(e.target.value)} disabled={prodLoading} className="select-field">
                <option value="" disabled>Select product…</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <p className="label-text" id="horizon-label">Horizon</p>
              <Segmented size="lg" label="Forecast period" value={period} onChange={setPeriod} options={[7, 14, 30].map(d => ({ value: d, label: `${d} days`, ariaLabel: `${d} day forecast` }))} />
            </div>
            <Button onClick={generate} disabled={loading || !selectedProduct} className="controls-submit" icon={loading ? <span className="spinner" aria-hidden="true" /> : <HiSparkles />}>
              {loading ? 'Generating…' : 'Generate forecast'}
            </Button>
          </div>
        </Panel>

        {/* ── States ───────────────────────────────────────────────────── */}
        {loading && (
          <Panel>
            <div className="projecting" role="status">
              <div className="projecting-days" aria-hidden="true">{Array.from({ length: period }, (_, i) => <i key={i} style={{ '--i': i }} />)}</div>
              <p className="projecting-title">Projecting {period} days, one day at a time…</p>
              <p className="projecting-note">Each predicted day feeds the next</p>
            </div>
          </Panel>
        )}

        {insufficientHistory && !loading && (
          <Panel tone="var(--warning)">
            <div className="status-callout">
              <p className="callout-kicker" style={{ color: 'var(--warning)' }}>More history needed</p>
              <h3>This product needs at least 30 days of sales.</h3>
              <p>It currently has <strong style={{ color: 'var(--warning)' }}>{insufficientHistory.days_available} days</strong> of data. Upload more history to unlock its forecast.</p>
              <Meter value={insufficientHistory.days_available} max={30} tone="var(--warning)" tall label="Days of history" />
              <p className="callout-note">{insufficientHistory.days_available} / 30 days</p>
              <Button href="/upload" icon={<HiArrowUpTray />}>Upload more data</Button>
            </div>
          </Panel>
        )}

        {error && !loading && (
          <Panel tone="var(--danger)">
            <div className="status-callout">
              <HiXCircle style={{ fontSize: 28, color: 'var(--danger)' }} aria-hidden="true" />
              <h3>{error}</h3>
              <Button onClick={generate}>Retry</Button>
            </div>
          </Panel>
        )}

        {!forecastData && !loading && !error && !insufficientHistory && (
          <Panel variant="subtle">
            <EmptyState icon={<HiChartBar />} title="No forecast yet">Choose a product and a horizon, then generate a forecast.</EmptyState>
          </Panel>
        )}

        {/* ── Results ──────────────────────────────────────────────────── */}
        {forecastData && !loading && (
          <Panel tone="var(--forecast)" className="animate-fadeUp" aria-labelledby="forecast-title">
            <PanelHeader title="Predicted demand" titleId="forecast-title" description={`Next ${period} days · ${isPersonal ? 'personalised model' : 'base model'} · hatched band shows the 95% range`}>
              <div className="chart-legend">
                <span style={{ '--tone': C.forecast }}><i />Predicted</span>
                <span style={{ '--tone': C.forecast }}><i className="is-band" />95% range</span>
              </div>
              <Button variant="secondary" size="sm" icon={<HiArrowDownTray />} onClick={exportCSV}>Export CSV</Button>
            </PanelHeader>
            <div className="forecast-layout">
              <div className="forecast-chart">
                <div className="chart-box" style={{ height: 320 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={forecastData.points.map(p => ({ ...p, bounds: [p.lower, p.upper] }))} margin={{ top: 10, right: 8, left: -16, bottom: 0 }}>
                      <HatchDefs id="confHatch" color={C.forecast} fadeId="demandFade" fadeColor={C.forecast} />
                      <CartesianGrid {...gridProps} />
                      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps} dy={8} minTickGap={20} />
                      <YAxis {...axisProps} />
                      <Tooltip content={<ChartTooltip labelFormatter={fmtDateLong} />} cursor={cursorProps} />
                      <Area type="monotone" dataKey="bounds" stroke="none" fill="url(#confHatch)" fillOpacity={1} name="95% Confidence" legendType="none" isAnimationActive={false} />
                      <Line type="monotone" dataKey="upper" stroke={C.forecast} strokeOpacity={0.35} strokeDasharray="2 4" strokeWidth={1} dot={false} name="Upper bound" />
                      <Line type="monotone" dataKey="lower" stroke={C.forecast} strokeOpacity={0.35} strokeDasharray="2 4" strokeWidth={1} dot={false} name="Lower bound" />
                      <Line type="monotone" dataKey="demand" stroke={C.forecast} strokeWidth={2.25} dot={false} activeDot={{ r: 4.5, fill: C.forecast, strokeWidth: 0 }} name="Predicted demand" />
                      {forecastData.summary?.peak_day && <ReferenceLine x={forecastData.summary.peak_day} stroke={C.rule} strokeDasharray="3 4" label={{ value: 'Peak', position: 'insideTopRight', fill: C.subtle, fontSize: 11, fontFamily: 'var(--font-sans)' }} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <aside className="forecast-side" aria-label="Forecast summary">
                <div className="forecast-side-block centered-stack">
                  <Gauge value={accuracy} size={140} label="Accuracy" suffix="%" tone={accuracy == null ? undefined : accTone(accuracy)} />
                  <p className="gauge-note" style={{ color: accuracy != null && accuracy < 40 ? 'var(--danger)' : undefined }}>{accSubLabel(accuracy)}</p>
                </div>
                <div className="forecast-side-block" style={{ padding: 0 }}>
                  <div className="figure-list">
                    <div style={{ '--tone': C.forecastSoft }}><span>Average per day</span><strong className="num">{forecastData.summary.avg}<em>units</em></strong></div>
                    <div><span>Peak day</span><strong className="num">{forecastData.summary.peak_val}<em>{fmtDate(forecastData.summary.peak_day)}</em></strong></div>
                    <div><span>Total</span><strong className="num">{forecastData.summary.total?.toLocaleString()}<em>over {period} days</em></strong></div>
                  </div>
                </div>
              </aside>
            </div>
          </Panel>
        )}

        {/* ── Personal model (always visible) ──────────────────────────── */}
        <FineTuneCard
          ftState={ftState}
          ftAccuracy={ftAccuracy}
          ftError={ftError}
          ftStarting={ftStarting}
          trainingEnabled={trainingEnabled}
          onStart={startFinetune}
          onRetry={() => setFtState('idle')}
          onGenerate={generate}
        />

        {forecastData && !loading && (
          <div className="page-grid">
            {features && (
              <Panel className="span-5" aria-labelledby="drivers-title">
                <PanelHeader title="What drives this forecast" titleId="drivers-title" description="The factors the model leaned on most" />
                <ol className="drivers">
                  {Object.entries(features).slice(0, 8).map(([f, imp], i) => {
                    const pct = (imp * 100).toFixed(1);
                    const barW = Math.min(100, imp * 100 * 2);
                    return (
                      <li key={f} className="driver">
                        <span className="driver-rank">{i + 1}</span>
                        <div>
                          <p className="driver-name">{label(f)}</p>
                          <div className="meter"><span style={{ width: barsVisible ? `${barW}%` : '0%', background: i === 0 ? C.forecast : `color-mix(in srgb, ${C.forecast} ${Math.max(35, 90 - i * 8)}%, ${C.bone})`, transitionDelay: `${i * 60}ms` }} /></div>
                        </div>
                        <span className="driver-value">{pct}%</span>
                      </li>
                    );
                  })}
                </ol>
              </Panel>
            )}

            <Panel className={`${features ? 'span-7' : 'span-12'}`} aria-labelledby="fva-title">
              <PanelHeader title="Forecast vs actual" titleId="fva-title" description="How earlier predictions matched real sales">
                <div className="chart-legend">
                  <span style={{ '--tone': C.forecast }}><i className="is-dash" />Predicted</span>
                  <span style={{ '--tone': C.data }}><i />Actual</span>
                </div>
                {comparison?.avg_accuracy != null && <span className="status" style={{ color: accTone(comparison.avg_accuracy) }}>{comparison.avg_accuracy}% average match</span>}
              </PanelHeader>
              <div className="panel-body">
                {comparison == null ? (
                  <div className="loading-block"><span className="spinner" aria-label="Loading comparison" /></div>
                ) : comparison.comparison?.length > 0 ? (
                  <div className="chart-box" style={{ height: 380 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={comparison.comparison} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid {...gridProps} />
                        <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps} dy={8} minTickGap={20} />
                        <YAxis {...axisProps} />
                        <Tooltip content={<ChartTooltip labelFormatter={fmtDate} />} cursor={cursorProps} />
                        <Line type="monotone" dataKey="predicted" stroke={C.forecast} strokeWidth={1.75} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} name="Predicted" />
                        <Line type="monotone" dataKey="actual" stroke={C.data} strokeWidth={2} dot={{ r: 2.5, fill: C.data, strokeWidth: 0 }} activeDot={{ r: 4.5, strokeWidth: 0 }} name="Actual" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState icon={<HiBoltSlash />} title="No comparison yet">This appears once a forecast period has passed and real sales come in. Generate a forecast today and revisit in a few days.</EmptyState>
                )}
              </div>
            </Panel>

            <Panel className="span-12" aria-labelledby="table-title">
              <PanelHeader title="Forecast data" titleId="table-title" description="Day-by-day values behind the chart">
                <Button variant="secondary" size="sm" icon={<HiArrowDownTray />} onClick={exportCSV}>Export CSV</Button>
              </PanelHeader>
              <div className="table-scroll" style={{ maxHeight: 340 }}>
                <table className="data-table">
                  <thead>
                    <tr>{['Date', 'Day', 'Predicted', 'Lower', 'Upper', 'Confidence'].map(h => <th key={h} className={['Predicted', 'Lower', 'Upper'].includes(h) ? 'is-num' : ''}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {forecastData.points.map((row, i) => (
                      <tr key={i}>
                        <td className="is-mono" style={{ whiteSpace: 'nowrap' }}>{row.date}</td>
                        <td>{row.day}</td>
                        <td className="is-num is-strong" style={{ color: C.forecastSoft }}>{row.demand}</td>
                        <td className="is-num">{row.lower}</td>
                        <td className="is-num">{row.upper}</td>
                        <td><span className="badge">95%</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}

// Header status for the personalised model (reads existing fine-tune state only).
function ModelStatus({ ftState, ftAccuracy, ftLastTrained }) {
  if (ftState === 'loading') return <Skeleton height={24} width={200} />;
  if (ftState === 'training') return <StatusBadge tone="accent">Training your model…</StatusBadge>;
  if (ftState === 'failed') return <StatusBadge tone="critical">Model training failed</StatusBadge>;
  if (ftState === 'has_model' || ftState === 'completed') {
    return (
      <StatusBadge tone="success">
        Personalised model{ftAccuracy != null ? ` · ${ftAccuracy}% accuracy` : ''}{ftLastTrained ? ` · trained ${fmtDate(ftLastTrained)}` : ''}
      </StatusBadge>
    );
  }
  return <StatusBadge tone="neutral">General model</StatusBadge>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONAL MODEL — idle · training · completed · has_model · failed
// ═══════════════════════════════════════════════════════════════════════════════

function FineTuneCard({ ftState, ftAccuracy, ftError, ftStarting, trainingEnabled, onStart, onRetry, onGenerate }) {
  if (ftState === 'loading') return null;

  if (ftState === 'idle' && !trainingEnabled) {
    return (
      <Panel variant="subtle">
        <div className="model-plate">
          <div>
            <p className="model-kicker" style={{ color: 'var(--text-2)' }}>Personal model training is off</p>
            <p className="model-copy">
              In our tests, extra training on a single store&apos;s history did not reliably improve forecasts, so training new
              personal models is turned off. Forecasts keep using the general model, or a personal model trained earlier.
            </p>
          </div>
        </div>
      </Panel>
    );
  }

  if (ftState === 'idle') {
    return (
      <Panel tone="var(--forecast)">
        <div className="model-plate">
          <div>
            <p className="model-kicker">Personalise your forecast</p>
            <h3>Make the model yours</h3>
            <p className="model-copy">The base model knows general retail patterns. Train it on your store&apos;s own history and it learns your rhythms — seasonal peaks, weekend spikes, quiet weeks.</p>
            <div className="model-facts"><span>Takes 2–3 minutes</span><span>Needs 30+ days of sales</span><span>Retrain any time</span></div>
          </div>
          <Button onClick={onStart} disabled={ftStarting} icon={ftStarting ? <span className="spinner" aria-hidden="true" /> : <HiBolt />}>
            {ftStarting ? 'Starting…' : 'Start training'}
          </Button>
        </div>
      </Panel>
    );
  }

  if (ftState === 'training') {
    return (
      <Panel tone="var(--forecast)">
        <div className="model-plate" role="status">
          <div>
            <p className="model-kicker"><span className="dot dot-live" style={{ '--tone': 'var(--accent)' }} />Training</p>
            <h3>Learning your store&apos;s patterns…</h3>
            <p className="model-copy">The model is studying your sales history. This usually takes 2–3 minutes — you can keep working meanwhile.</p>
            <div className="training-bar" aria-hidden="true" />
          </div>
        </div>
      </Panel>
    );
  }

  if (ftState === 'completed') {
    return (
      <Panel tone="var(--success)" className="animate-fadeUp">
        <div className="model-plate">
          <div>
            <p className="model-kicker" style={{ color: 'var(--success)' }}><HiCheckCircle aria-hidden="true" />Ready</p>
            <h3>Your model is ready</h3>
            <p className="model-copy">
              Personalised accuracy:{' '}
              {ftAccuracy != null ? <strong style={{ color: accTone(ftAccuracy) }}>{ftAccuracy}%</strong> : <span>computing…</span>}
              {' '}· switching to your model in a moment.
            </p>
          </div>
          <Button onClick={onGenerate} icon={<HiSparkles />}>Generate with my model</Button>
        </div>
      </Panel>
    );
  }

  // has_model: status and the retrain action live in the page header.
  if (ftState === 'has_model') return null;

  if (ftState === 'failed') {
    return (
      <Panel tone="var(--danger)">
        <div className="model-plate">
          <div>
            <p className="model-kicker" style={{ color: 'var(--danger)' }}>Training failed</p>
            <p className="model-copy">{ftError || 'An unexpected error occurred. Please try again.'}</p>
          </div>
          {trainingEnabled && <Button variant="danger" onClick={onRetry} icon={<HiArrowPath />}>Retry</Button>}
        </div>
      </Panel>
    );
  }

  return null;
}
