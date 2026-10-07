'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { HiUser, HiEnvelope, HiLockClosed, HiEye, HiEyeSlash, HiArrowRight } from 'react-icons/hi2';
import AuthLayout from '../../components/AuthLayout';
import Segmented from '../../components/ui/Segmented';

const ROLES = [
  { value: 'seller', label: 'Seller', desc: 'Run your store and act on its insights' },
  { value: 'analyst', label: 'Analyst', desc: 'Explore trends and performance' },
  { value: 'admin', label: 'Admin', desc: 'Manage the workspace and its settings' },
];
const STRENGTH_COLORS = ['', 'var(--danger)', 'var(--warning)', 'var(--data)', 'var(--success)'];

export default function SignupPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'seller' });
  const [errors, setErrors] = useState({});
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const e = {};
    if (!form.name.trim() || form.name.trim().length < 2) e.name = 'Name must be at least 2 characters';
    if (!form.email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Invalid email address';
    if (!form.password || form.password.length < 6) e.password = 'Password must be at least 6 characters';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      await register(form.name.trim(), form.email.trim(), form.password, form.role);
      toast.success('Account created! Welcome to NexusCommerce.');
      router.push('/dashboard');
    } catch (err) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || 'Registration failed. Please try again.';
      toast.error(msg);
      setErrors({ submit: msg });
    } finally {
      setLoading(false);
    }
  };

  const set = field => e => {
    setForm(f => ({ ...f, [field]: e.target.value }));
    if (errors[field]) setErrors(er => ({ ...er, [field]: '' }));
  };

  const strength = (() => {
    const p = form.password;
    if (!p) return 0;
    let s = 0;
    if (p.length >= 6) s++;
    if (p.length >= 10) s++;
    if (/[A-Z]/.test(p)) s++;
    if (/[0-9]/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    return Math.min(s, 4);
  })();
  const strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong'][strength];
  const strengthColor = STRENGTH_COLORS[strength];

  return (
    <AuthLayout signup>
      <p className="eyebrow">Create a workspace</p>
      <h1 className="display auth-title">A clearer view <em>starts here.</em></h1>
      <p className="auth-subtitle">Set up your account, then bring in a sales file to begin.</p>

      {errors.submit && <div className="form-alert" role="alert">{errors.submit}</div>}

      <form onSubmit={handleSubmit} className="auth-form" noValidate>
        {[
          { field: 'name', label: 'Full name', type: 'text', placeholder: 'Your name', Icon: HiUser },
          { field: 'email', label: 'Email address', type: 'email', placeholder: 'you@company.com', Icon: HiEnvelope },
        ].map(({ field, label, type, placeholder, Icon }) => (
          <div key={field}>
            <label htmlFor={`signup-${field}`} className="label-text">{label}</label>
            <div className="input-icon-wrap">
              <Icon className="input-icon" />
              <input id={`signup-${field}`} type={type} placeholder={placeholder} value={form[field]} onChange={set(field)} className="input-field input-with-icon" autoComplete={field} required aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${field}-error` : undefined} />
            </div>
            {errors[field] && <p id={`${field}-error`} className="err-msg" role="alert">{errors[field]}</p>}
          </div>
        ))}

        <fieldset className="auth-fieldset">
          <legend className="label-text">Your role</legend>
          <Segmented options={ROLES} value={form.role} onChange={role => setForm(f => ({ ...f, role }))} label="Your role" fill />
          <p className="auth-hint" aria-live="polite">{ROLES.find(r => r.value === form.role)?.desc}</p>
        </fieldset>

        <div>
          <label htmlFor="signup-password" className="label-text">Password</label>
          <div className="input-icon-wrap">
            <HiLockClosed className="input-icon" />
            <input id="signup-password" type={showPw ? 'text' : 'password'} placeholder="At least 6 characters" value={form.password} onChange={set('password')} className="input-field input-with-icon" style={{ paddingRight: 44 }} autoComplete="new-password" required aria-invalid={!!errors.password} aria-describedby={errors.password ? 'password-error' : 'password-strength'} />
            <button type="button" className="pw-toggle" onClick={() => setShowPw(s => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <HiEyeSlash /> : <HiEye />}</button>
          </div>
          <div id="password-strength" aria-live="polite">
            {form.password && (
              <div className="strength">
                <div className="strength-bars" aria-hidden="true">
                  {[1, 2, 3, 4].map(n => <span key={n} style={{ background: n <= strength ? strengthColor : undefined }} />)}
                </div>
                <p style={{ color: strengthColor }}>{strengthLabel} password</p>
              </div>
            )}
          </div>
          {errors.password && <p id="password-error" className="err-msg" role="alert">{errors.password}</p>}
        </div>

        <button type="submit" className="btn-primary btn-block auth-submit" disabled={loading} aria-busy={loading}>
          {loading ? <><span className="spinner" aria-hidden="true" />Creating your account…</> : <>Create workspace <HiArrowRight /></>}
        </button>
      </form>

      <p className="auth-switch">Already have an account? <Link href="/login" className="link-arrow">Sign in <HiArrowRight /></Link></p>
    </AuthLayout>
  );
}
