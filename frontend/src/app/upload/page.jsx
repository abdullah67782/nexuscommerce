'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ProtectedRoute from '../../components/ProtectedRoute';
import PageHeader from '../../components/PageHeader';
import Dialog from '../../components/Dialog';
import { Panel, PanelHeader } from '../../components/ui/Panel';
import Stat from '../../components/ui/Stat';
import StatusBadge from '../../components/ui/StatusBadge';
import Button from '../../components/ui/Button';
import Skeleton from '../../components/ui/Skeleton';
import Segmented from '../../components/ui/Segmented';
import EmptyState from '../../components/ui/EmptyState';
import api from '../../services/api';
import toast from 'react-hot-toast';
import {
  HiArrowUpTray, HiDocumentText, HiXMark, HiCheckCircle, HiArrowDownTray,
  HiChevronDown, HiSparkles, HiExclamationTriangle, HiShieldCheck, HiTrash, HiArrowRight,
} from 'react-icons/hi2';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtSize = (b) => { if (!b) return '0 B'; const k = 1024, s = ['B', 'KB', 'MB']; const i = Math.floor(Math.log(b) / Math.log(k)); return `${(b / Math.pow(k, i)).toFixed(1)} ${s[i]}`; };
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtNum = (n) => (n ?? 0).toLocaleString();
const qTone = (s) => s >= 80 ? 'var(--success)' : s >= 60 ? 'var(--warning)' : 'var(--danger)';
const qStatus = (s) => s >= 80 ? 'status-ok' : s >= 60 ? 'status-warning' : 'status-critical';

const UPLOAD_STEPS = ['Parsing file', 'Validating data', 'Checking duplicates', 'Inserting records', 'Complete'];

const ANOMALY_TYPE_LABELS = {
  duplicate_transaction: 'Duplicate transaction',
  future_date: 'Future date',
  negative_value: 'Negative value',
  zero_price: 'Zero price',
  zero_quantity: 'Zero quantity',
  zero_revenue: 'Zero revenue',
  invalid_date: 'Invalid date',
  old_date: 'Date >10 years old',
  missing_product_name: 'Missing product name',
  missing_quantity: 'Missing quantity',
  invalid_quantity: 'Quantity is not a number',
  fractional_quantity: 'Fractional quantity',
  unusually_large_order: 'Unusually large order (kept)',
};

const COLS = ['product_name', 'category', 'price', 'quantity', 'sale_date', 'revenue', 'stock_level', 'reorder_threshold'];

// ─── Sub-components ──────────────────────────────────────────────────────────
function FreshnessBadge({ freshness, loading }) {
  if (loading) return <Skeleton height={24} width={140} />;
  if (!freshness) return null;
  const score = freshness.freshness_score ?? 0;
  const days = freshness.days_since_upload;
  const label = score > 70 ? 'Data fresh' : score >= 40 ? 'Needs update' : 'Data stale';
  const cls = score > 70 ? 'status-ok' : score >= 40 ? 'status-warning' : 'status-critical';
  return (
    <span className={`status ${cls}`}>
      {label}{days !== null && days !== undefined && <span style={{ opacity: .7 }}>· {days === 0 ? 'today' : `${days}d ago`}</span>}
    </span>
  );
}

function Pipeline({ step }) {
  return (
    <div>
      <p className="side-label">Processing your data</p>
      <ol className="pipeline" aria-label="Upload progress">
        {UPLOAD_STEPS.map((label, i) => {
          const n = i + 1;
          const state = step > n ? 'is-done' : step === n ? 'is-active' : '';
          return (
            <li key={label} className={state} aria-current={step === n ? 'step' : undefined}>
              <span className="pipeline-node" aria-hidden="true" />
              <span>{label}{step === n && n < 5 ? '…' : ''}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ResultCard({ result, onViewAnomalies, onRollback }) {
  if (!result) return null;
  const { total_rows = 0, inserted = 0, skipped = 0, rejected = 0, quality_score = 0, version_number } = result;
  return (
    <Panel tone="var(--success)" aria-labelledby="result-title">
      <PanelHeader
        titleId="result-title"
        title={<span className="title-with-icon"><HiCheckCircle style={{ color: 'var(--success)' }} aria-hidden="true" />Upload complete{version_number ? ` — version #${version_number}` : ''}</span>}
        description="Your sales data has been processed"
      />
      <div className="result-grid">
        {[
          { label: 'Rows in file', value: fmtNum(total_rows) },
          { label: 'New rows added', value: fmtNum(inserted), tone: 'var(--success)' },
          { label: 'Duplicates skipped', value: fmtNum(skipped), tone: 'var(--warning)' },
          { label: 'Rows rejected', value: fmtNum(rejected), tone: 'var(--danger)' },
          { label: 'Quality score', value: `${quality_score}/100`, tone: qTone(quality_score) },
        ].map(({ label, value, tone }) => (
          <div key={label} style={tone ? { '--tone': tone } : undefined}><span>{label}</span><strong className="num">{value}</strong></div>
        ))}
      </div>
      <ResultNotes result={result} />
      {(result.anomaly_count > 0 || inserted > 0) && (
        <div className="panel-foot panel-foot-start">
          {result.anomaly_count > 0 && <Button variant="secondary" size="sm" icon={<HiExclamationTriangle />} onClick={onViewAnomalies}>View {result.anomaly_count} anomalies</Button>}
          {inserted > 0 && <Button variant="danger" size="sm" icon={<HiTrash />} onClick={() => onRollback(result)}>Roll back upload</Button>}
        </div>
      )}
    </Panel>
  );
}

// Optional declaration that the file holds EVERY sale for a period. Inside a
// confirmed period, days without rows count as zero sales; elsewhere they stay
// unknown. A file with no sales rows is accepted only with this confirmation.
function CoverageForm({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <fieldset className="coverage-form">
      <label className="coverage-check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>
          <strong>This file contains every sale for a period</strong>
          <em>Confirm the dates it covers so that days without sales count as zero, not as missing data.</em>
        </span>
      </label>
      {value.enabled && (
        <div className="coverage-fields">
          <div>
            <label htmlFor="coverage-start" className="label-text">First day</label>
            <input id="coverage-start" type="date" className="input-field" value={value.start} max={value.end || undefined} onChange={(e) => set({ start: e.target.value })} />
          </div>
          <div>
            <label htmlFor="coverage-end" className="label-text">Last day</label>
            <input id="coverage-end" type="date" className="input-field" value={value.end} min={value.start || undefined} onChange={(e) => set({ end: e.target.value })} />
          </div>
          <div className="coverage-scope">
            <p className="label-text">Products</p>
            <Segmented label="Products covered" value={value.scope} onChange={(scope) => set({ scope })} fill
              options={[{ value: 'all_products', label: 'All my products' }, { value: 'listed_products', label: 'Only products in this file' }]} />
          </div>
          <p className="side-note coverage-statement">
            {value.start && value.end
              ? <>By uploading, you confirm that no sale of {value.scope === 'all_products' ? 'any of your products' : 'the products in this file'} from <strong>{value.start}</strong> to <strong>{value.end}</strong> is missing from this file.</>
              : 'Choose the first and last day the file covers.'}
          </p>
        </div>
      )}
    </fieldset>
  );
}

function ResultNotes({ result }) {
  if (!result) return null;
  const { coverage, large_orders_flagged: large, date_help: dateHelp, source_timezone: tz } = result;
  if (!coverage && !large && !dateHelp) return null;
  return (
    <div className="panel-body result-notes">
      {coverage && (
        <p><HiShieldCheck aria-hidden="true" style={{ color: 'var(--success)' }} />
          Confirmed complete: {coverage.start} to {coverage.end} ({coverage.days} days, {coverage.products === 'all' ? 'all products' : `${coverage.products} product${coverage.products === 1 ? '' : 's'}`}){tz ? `, ${tz} business days` : ''}. Days without sales in this period count as zero.</p>
      )}
      {large > 0 && (
        <p><HiExclamationTriangle aria-hidden="true" style={{ color: 'var(--warning)' }} />
          {large} unusually large order{large === 1 ? ' was' : 's were'} kept and flagged for review — see Data anomalies.</p>
      )}
      {dateHelp && (
        <div className="date-help">
          <p><HiExclamationTriangle aria-hidden="true" style={{ color: 'var(--warning)' }} />{dateHelp.message}</p>
          <ul className="overlap-list">{dateHelp.accepted_formats.map((f) => <li key={f}>{f}</li>)}</ul>
          {dateHelp.examples?.length > 0 && <p className="side-note">Not read: {dateHelp.examples.map((e) => `row ${e.row} “${e.value}”`).join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

function RollbackModal({ version, onClose, onConfirm, loading }) {
  const [text, setText] = useState('');
  if (!version) return null;
  const armed = text === 'ROLLBACK';
  return (
    <Dialog onClose={onClose} labelledBy="rollback-title" describedBy="rollback-description" busy={loading}>
      <p className="dialog-kicker" style={{ color: 'var(--danger)' }}>Version #{version.version_number}</p>
      <h2 id="rollback-title" className="dialog-title" style={{ marginTop: 10 }}>Roll back this upload?</h2>
      <p id="rollback-description" style={{ margin: '14px 0 20px', fontSize: 13.5, lineHeight: 1.7, color: 'var(--muted)' }}>
        This permanently deletes <strong style={{ color: 'var(--danger)' }}>{fmtNum(version.rows_added)} records</strong> from your sales history. It cannot be undone.
      </p>
      <label htmlFor="rollback-confirmation" className="label-text">Type <strong style={{ color: 'var(--foreground)' }}>ROLLBACK</strong> to confirm</label>
      <input type="text" id="rollback-confirmation" value={text} onChange={(e) => setText(e.target.value)} placeholder="ROLLBACK" className="input-field" autoComplete="off" />
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button onClick={onClose} disabled={loading} className="btn-secondary" style={{ flex: 1 }}>Cancel</button>
        <button onClick={onConfirm} disabled={!armed || loading} className={`btn-danger ${armed ? 'is-armed' : ''}`} style={{ flex: 1 }}>
          {loading ? <span className="spinner" aria-label="Rolling back" /> : <><HiTrash />Roll back</>}
        </button>
      </div>
    </Dialog>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function UploadPage() {
  const router = useRouter();
  const fileRef = useRef(null);
  const anomalyRef = useRef(null);
  const guideRef = useRef(null);

  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState(null);

  const [freshness, setFreshness] = useState(null);
  const [freshnessLoading, setFreshnessLoading] = useState(true);
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [anomalies, setAnomalies] = useState([]);
  const [anomaliesLoading, setAnomaliesLoading] = useState(true);
  const [anomalyFilter, setAnomalyFilter] = useState('all');

  const [rollbackTarget, setRollbackTarget] = useState(null);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // Set when the server refuses a file because it overlaps sales already
  // imported for the same products and dates; the seller decides what it is.
  const [overlap, setOverlap] = useState(null);
  const [coverage, setCoverage] = useState({ enabled: false, start: '', end: '', scope: 'all_products' });

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const fetchPageData = useCallback(async () => {
    const [freshnessR, versionsR, anomaliesR] = await Promise.allSettled([
      api.get('/data/freshness'),
      api.get('/data/versions'),
      api.get('/data/anomalies'),
    ]);
    if (freshnessR.status === 'fulfilled') setFreshness(freshnessR.value.data);
    setFreshnessLoading(false);
    if (versionsR.status === 'fulfilled') setVersions(versionsR.value.data?.versions || []);
    setVersionsLoading(false);
    if (anomaliesR.status === 'fulfilled') setAnomalies(anomaliesR.value.data?.anomalies || []);
    setAnomaliesLoading(false);
  }, []);

  useEffect(() => { fetchPageData(); }, [fetchPageData]);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const totalRecords = freshness?.total_records ?? 0;
  const lastUploadDate = freshness?.last_upload_at ? fmtDate(freshness.last_upload_at) : '—';
  const latestVersion = versions.find((v) => !v.is_rolled_back);
  const latestQuality = latestVersion ? parseFloat(latestVersion.quality_score) : 0;
  const unresolvedAnom = anomalies.filter((a) => !a.resolved).length;

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const onDrag = (e) => { e.preventDefault(); e.stopPropagation(); setDrag(e.type === 'dragenter' || e.type === 'dragover'); };
  const onDrop = (e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); };
  const pick = (f) => {
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['csv', 'json', 'xlsx', 'xls'].includes(ext)) { toast.error('Please upload CSV, JSON or Excel'); return; }
    setFile(f); setResult(null); setStep(0);
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  // Each upload action gets its own operation id. Automatic retries of the
  // same request reuse it (and are replayed, never imported twice); choosing
  // "add as extra sales" re-sends the same operation with overlap_mode=append.
  const newOperationId = () => (globalThis.crypto?.randomUUID?.() || `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const handleUpload = async (overlapMode = 'reject', operationId = newOperationId()) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('operation_id', operationId);
    if (overlapMode === 'append') fd.append('overlap_mode', 'append');
    if (coverage.enabled) {
      if (!coverage.start || !coverage.end) { toast.error('Choose the first and last day the file covers'); return; }
      fd.append('coverage_start', coverage.start);
      fd.append('coverage_end', coverage.end);
      fd.append('coverage_scope', coverage.scope);
      fd.append('coverage_confirmed', 'true');
    }
    setOverlap(null);
    setUploading(true); setStep(1);
    const timers = [setTimeout(() => setStep(2), 600), setTimeout(() => setStep(3), 1400), setTimeout(() => setStep(4), 2300)];
    try {
      const r = await api.post('/data/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      timers.forEach(clearTimeout);
      setStep(5);
      const d = r.data;
      setResult(d);
      if (d.replayed) {
        toast(d.rolled_back
          ? 'This upload was already processed and then rolled back. Nothing was imported again.'
          : 'This upload was already processed. Showing the original result.', { duration: 5000 });
      } else {
        toast.success('File processed successfully!');
      }
      if (!d.replayed && d.skipped > 0) {
        setTimeout(() => {
          toast(`${fmtNum(d.skipped)} lines were already imported earlier (same line id) and were skipped.`, { duration: 5000 });
        }, 1200);
      }
      setTimeout(() => { setUploading(false); setFile(null); setStep(0); setCoverage((c) => ({ ...c, enabled: false })); fetchPageData(); }, 1500);
    } catch (err) {
      timers.forEach(clearTimeout);
      const body = err.response?.data;
      if (err.response?.status === 409 && body?.error === 'overlap_requires_choice') {
        setOverlap({ operationId, count: body.overlap_count, examples: body.overlaps || [] });
      } else {
        toast.error(body?.message || body?.error || 'Processing failed');
      }
      setUploading(false); setStep(0);
    }
  };

  // ── Rollback ──────────────────────────────────────────────────────────────
  const handleRollback = async () => {
    if (!rollbackTarget) return;
    setRollbackLoading(true);
    try {
      await api.post(`/data/rollback/${rollbackTarget.upload_id}`);
      toast.success('Upload rolled back successfully');
      setRollbackTarget(null);
      fetchPageData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Rollback failed');
    } finally {
      setRollbackLoading(false);
    }
  };

  // ── Resolve anomaly ───────────────────────────────────────────────────────
  const resolveAnomaly = async (id) => {
    try {
      await api.patch(`/data/anomalies/${id}/resolve`);
      setAnomalies((prev) => prev.map((a) => a.id === id ? { ...a, resolved: true } : a));
      toast.success('Marked as resolved');
    } catch {
      toast.error('Failed to resolve anomaly');
    }
  };

  // ── Sample CSV ────────────────────────────────────────────────────────────
  const downloadSample = () => {
    const csv = `product_name,category,price,quantity,sale_date,revenue,stock_level,reorder_threshold
Wireless Mouse,Electronics,29.99,50,2023-10-01,1499.50,150,20
Mechanical Keyboard,Electronics,89.99,20,2023-10-02,1799.80,85,15
Desk Mat,Accessories,19.99,100,2023-10-02,1999.00,300,50`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'nexus_sample_data.csv'; a.click();
    toast.success('Sample downloaded');
  };

  // ── Anomaly filter ────────────────────────────────────────────────────────
  const filteredAnomalies = anomalies.filter((a) => {
    if (anomalyFilter === 'resolved') return a.resolved;
    if (anomalyFilter === 'all') return !a.resolved;
    return !a.resolved && a.severity === anomalyFilter;
  });
  const sevStatus = (sev) => sev === 'critical' ? 'status-critical' : sev === 'warning' ? 'status-warning' : 'status-info';

  return (
    <ProtectedRoute>
      <div className="page">
        <PageHeader
          title="Data Integration"
          description="Bring in your sales history, check its quality and keep every version in view."
          meta={<FreshnessBadge freshness={freshness} loading={freshnessLoading} />}
        >
          <Button variant="secondary" icon={<HiArrowDownTray />} onClick={downloadSample}>Sample CSV</Button>
        </PageHeader>

        <section className="figures" aria-label="Data summary">
          <Stat label="Total records" value={fmtNum(totalRecords)} tone="var(--data)" loading={freshnessLoading} />
          <Stat label="Last upload" value={lastUploadDate} tone="var(--foreground)" loading={freshnessLoading} />
          <Stat label="Quality score" value={latestQuality.toFixed(0)} unit="/ 100" tone={qTone(latestQuality)} loading={versionsLoading} />
          <Stat label="Anomalies" value={fmtNum(unresolvedAnom)} hint={unresolvedAnom > 0 ? 'unresolved' : 'all clear'} tone={unresolvedAnom > 0 ? 'var(--warning)' : 'var(--success)'} loading={anomaliesLoading} />
        </section>

        {overlap && !uploading && (
          <Panel tone="var(--warning)" aria-labelledby="overlap-title">
            <PanelHeader title="These sales may already be imported" titleId="overlap-title"
              description={`${fmtNum(overlap.count)} product/date ${overlap.count === 1 ? 'combination already has' : 'combinations already have'} sales from an earlier file. Nothing was imported.`} />
            <div className="panel-body overlap-body">
              <p className="side-note">
                The file has no line ids, so its rows can&apos;t be matched to the earlier ones. If this file repeats sales
                you already uploaded, cancel. If these are additional sales on the same days, add them.
              </p>
              <ul className="overlap-list">
                {overlap.examples.slice(0, 5).map((o) => <li key={`${o.product}-${o.sale_date}`}><strong>{o.product}</strong> · {o.sale_date}</li>)}
              </ul>
              <div className="toolbar">
                <Button variant="secondary" onClick={() => setOverlap(null)}>Cancel</Button>
                <Button onClick={() => handleUpload('append', overlap.operationId)}>Add as extra sales</Button>
              </div>
            </div>
          </Panel>
        )}

        {!result && (
          <Panel tone="var(--data)" aria-labelledby="intake-title">
            <PanelHeader title="Upload sales data" titleId="intake-title" description="CSV, JSON or Excel — validated before anything is saved; sending the same file again never imports it twice" />
            <div className="intake">
              <div className="intake-main">
                {!file && !uploading && (
                  <div
                    onDragEnter={onDrag} onDragLeave={onDrag} onDragOver={onDrag} onDrop={onDrop}
                    role="button" tabIndex={0} aria-label="Choose sales data file or drop a file here"
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                    onClick={e => { if (e.target !== fileRef.current) fileRef.current?.click(); }}
                    className={`dropzone ${drag ? 'is-dragging' : ''}`}
                  >
                    <span className="dropzone-mark" aria-hidden="true"><HiArrowUpTray /></span>
                    <div>
                      <h3>{drag ? 'Release to upload' : 'Drop a sales file here'}</h3>
                      <p>or <span className="dropzone-link">browse your computer</span> · up to 50 MB</p>
                    </div>
                    <div className="format-row">{['CSV', 'JSON', 'XLSX', 'XLS'].map((f) => <span key={f} className="badge">{f}</span>)}</div>
                    <input ref={fileRef} aria-label="Sales data file" type="file" accept=".csv,.json,.xlsx,.xls" onChange={(e) => e.target.files[0] && pick(e.target.files[0])} hidden />
                  </div>
                )}

                {file && !uploading && (
                  <div className="file-ready">
                    <div className="file-row">
                      <span className="file-row-mark" aria-hidden="true"><HiDocumentText /></span>
                      <div className="list-row-main">
                        <p className="list-row-title">{file.name}</p>
                        <p className="list-row-meta">{fmtSize(file.size)}</p>
                      </div>
                      <button aria-label="Remove selected file" onClick={() => setFile(null)} className="icon-button"><HiXMark /></button>
                    </div>
                    <CoverageForm value={coverage} onChange={setCoverage} />
                    <Button block icon={<HiSparkles />} onClick={() => handleUpload()}>Process &amp; upload file</Button>
                  </div>
                )}

                {uploading && <Pipeline step={step} />}
              </div>

              <div className="intake-side">
                <p className="side-label">Required columns</p>
                <div className="chip-row">{COLS.map((c) => <code key={c} className="code-chip">{c}</code>)}</div>
                <p className="side-note">Each row is checked before anything is stored. Rows with a missing, fractional or negative quantity, or an ambiguous or future date, are set aside — nothing is filled in by guessing. Unusually large orders are kept and flagged.</p>
                <button
                  onClick={() => { setGuideOpen(true); requestAnimationFrame(() => guideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}
                  className="link-arrow" style={{ justifySelf: 'start' }} aria-controls="format-guide"
                >
                  See the format guide <HiArrowRight />
                </button>
              </div>
            </div>
          </Panel>
        )}

        {result && (
          <div className="stack">
            <div className="toolbar">
              <Button variant="ghost" icon={<HiArrowUpTray />} onClick={() => setResult(null)}>Upload another file</Button>
              <span className="toolbar-spacer" />
              <Button size="sm" iconRight={<HiArrowRight />} onClick={() => router.push('/dashboard')}>View overview</Button>
            </div>
            <ResultCard
              result={result}
              onViewAnomalies={() => anomalyRef.current?.scrollIntoView({ behavior: 'smooth' })}
              onRollback={(r) => setRollbackTarget({ upload_id: r.upload_id, version_number: r.version_number, rows_added: r.inserted })}
            />
          </div>
        )}

        <div ref={anomalyRef} className="scroll-target">
          <Panel tone="var(--warning)" aria-labelledby="anomalies-title">
            <PanelHeader title="Data anomalies" titleId="anomalies-title" description="Rows set aside during validation — mark them resolved once they are fixed at the source">
              {unresolvedAnom > 0 && <StatusBadge tone="critical">{unresolvedAnom} unresolved</StatusBadge>}
            </PanelHeader>
            <div className="panel-toolbar">
              <Segmented
                label="Filter anomalies"
                value={anomalyFilter}
                onChange={setAnomalyFilter}
                options={[
                  { value: 'all', label: 'Unresolved', count: anomalies.filter(a => !a.resolved).length },
                  { value: 'critical', label: 'Critical', count: anomalies.filter(a => !a.resolved && a.severity === 'critical').length },
                  { value: 'warning', label: 'Warning', count: anomalies.filter(a => !a.resolved && a.severity === 'warning').length },
                  { value: 'info', label: 'Info', count: anomalies.filter(a => !a.resolved && a.severity === 'info').length },
                  { value: 'resolved', label: 'Resolved', count: anomalies.filter(a => a.resolved).length },
                ]}
              />
            </div>
            <div className="panel-scroll">
              {anomaliesLoading ? (
                <div className="panel-body"><Skeleton height={120} /></div>
              ) : filteredAnomalies.length > 0 ? (
                <ul className="row-list">
                  {filteredAnomalies.map((a) => (
                    <li key={a.id} className="list-row">
                      <span className={`status ${sevStatus(a.severity)} sev-badge`}>{a.severity}</span>
                      <div className="list-row-main">
                        <p className="list-row-title">{a.product_name} <span className="list-row-aside">· {ANOMALY_TYPE_LABELS[a.anomaly_type] || a.anomaly_type}</span></p>
                        <p className="list-row-meta">
                          <span>Field <strong>{a.field}</strong></span>
                          <span>Value <code className="code-chip">{String(a.original_value).slice(0, 40)}</code></span>
                          <span>Row #{a.row_number}</span>
                        </p>
                      </div>
                      {!a.resolved
                        ? <Button variant="secondary" size="sm" onClick={() => resolveAnomaly(a.id)}>Resolve</Button>
                        : <StatusBadge tone="success">Resolved</StatusBadge>}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={<HiShieldCheck />} title="Nothing to review">No anomalies match this filter.</EmptyState>
              )}
            </div>
          </Panel>
        </div>

        <Panel aria-labelledby="history-title">
          <PanelHeader title="Upload history" titleId="history-title" description="Every import is kept as a version — the latest active one can be rolled back">
            {versions.length > 0 && <span className="badge">{versions.length} versions</span>}
          </PanelHeader>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>{['Version', 'Date', 'Rows added', 'Skipped', 'Rejected', 'Quality', 'Status', ''].map((h, i) => <th key={i} className={['Rows added', 'Skipped', 'Rejected'].includes(h) ? 'is-num' : ''}>{h || <span className="visually-hidden">Actions</span>}</th>)}</tr>
              </thead>
              <tbody>
                {versionsLoading ? (
                  [...Array(3)].map((_, i) => <tr key={i}><td colSpan={8}><Skeleton height={18} /></td></tr>)
                ) : versions.length > 0 ? (
                  versions.map((v, i) => {
                    const isLatestActive = i === 0 && !v.is_rolled_back;
                    const q = parseFloat(v.quality_score);
                    return (
                      <tr key={v.id} className={v.is_rolled_back ? 'is-muted' : ''}>
                        <td className="is-strong is-mono">#{v.version_number}</td>
                        <td>{fmtDate(v.created_at)}</td>
                        <td className="is-num" style={{ color: 'var(--success)' }}>{fmtNum(v.rows_added)}</td>
                        <td className="is-num" style={{ color: 'var(--warning)' }}>{fmtNum(v.rows_skipped)}</td>
                        <td className="is-num" style={{ color: 'var(--danger)' }}>{fmtNum(v.rows_rejected)}</td>
                        <td><span className={`status ${qStatus(q)}`}>{q.toFixed(0)}</span></td>
                        <td>{v.is_rolled_back ? <StatusBadge tone="critical">Rolled back</StatusBadge> : <StatusBadge tone="success">Active</StatusBadge>}</td>
                        <td style={{ textAlign: 'right' }}>{isLatestActive && <button onClick={() => setRollbackTarget(v)} className="btn-ghost btn-sm text-critical"><HiTrash />Rollback</button>}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr><td colSpan={8}><EmptyState title="No uploads yet">Your first import will appear here as version #1.</EmptyState></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel ref={guideRef} className="scroll-target">
          <button onClick={() => setGuideOpen((g) => !g)} aria-expanded={guideOpen} aria-controls="format-guide" className="panel-head disclosure">
            <span>
              <span className="panel-title">Data format guide</span>
              <span className="panel-desc">Column types, with valid and invalid examples</span>
            </span>
            <HiChevronDown className="disclosure-icon" aria-hidden="true" />
          </button>
          {guideOpen && (
            <div id="format-guide">
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr>{['Column', 'Type', 'Valid example', 'Invalid example'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {[
                      ['product_name', 'String', 'Wireless Mouse', '(empty)'],
                      ['price', 'Float > 0', '29.99', '$29.99 or -5'],
                      ['quantity', 'Whole number > 0', '50', 'empty, 1.5, -10 or zero'],
                      ['sale_date', 'YYYY-MM-DD', '2023-10-01', '10/01/23 (ambiguous) or future'],
                      ['revenue', 'Float > 0', '1499.50', '0 or negative'],
                      ['line_id (optional)', 'Text, unique per sale line', 'ORD-1001-2', 'same id reused for a different sale'],
                    ].map(([c, t, g, b]) => (
                      <tr key={c}>
                        <td><code className="code-chip">{c}</code></td>
                        <td>{t}</td>
                        <td style={{ color: 'var(--success)' }}>{g}</td>
                        <td style={{ color: 'var(--danger)' }}>{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel-foot"><button onClick={downloadSample} className="link-arrow"><HiArrowDownTray />Download sample CSV</button></div>
            </div>
          )}
        </Panel>
      </div>

      <RollbackModal
        key={rollbackTarget?.upload_id ?? 'closed'}
        version={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onConfirm={handleRollback}
        loading={rollbackLoading}
      />
    </ProtectedRoute>
  );
}
