'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';
import { HiEnvelope, HiLockClosed, HiEye, HiEyeSlash, HiArrowRight } from 'react-icons/hi2';
import AuthLayout from '../../components/AuthLayout';

const DEMO = [['seller@nexus.com', 'Seller'], ['analyst@nexus.com', 'Analyst'], ['admin@nexus.com', 'Admin']];

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const e = {};
    if (!form.email.trim()) e.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Invalid email';
    if (!form.password) e.password = 'Password is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      await login(form.email, form.password);
      toast.success('Welcome back!');
      router.push('/dashboard');
    } catch (err) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || 'Invalid credentials';
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

  return (
    <AuthLayout>
      <p className="eyebrow">Sign in</p>
      <h1 className="display auth-title">Welcome <em>back.</em></h1>
      <p className="auth-subtitle">Your workspace picks up where you left it.</p>

      {errors.submit && <div className="form-alert" role="alert">{errors.submit}</div>}

      <form onSubmit={handleSubmit} className="auth-form" noValidate>
        <div>
          <label htmlFor="login-email" className="label-text">Email address</label>
          <div className="input-icon-wrap">
            <HiEnvelope className="input-icon" />
            <input id="login-email" type="email" placeholder="you@company.com" value={form.email} onChange={set('email')} className="input-field input-with-icon" autoComplete="email" required aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} />
          </div>
          {errors.email && <p id="email-error" className="err-msg" role="alert">{errors.email}</p>}
        </div>
        <div>
          <label htmlFor="login-password" className="label-text">Password</label>
          <div className="input-icon-wrap">
            <HiLockClosed className="input-icon" />
            <input id="login-password" type={showPw ? 'text' : 'password'} placeholder="Enter your password" value={form.password} onChange={set('password')} className="input-field input-with-icon" style={{ paddingRight: 44 }} autoComplete="current-password" required aria-invalid={!!errors.password} aria-describedby={errors.password ? 'password-error' : undefined} />
            <button type="button" className="pw-toggle" onClick={() => setShowPw(s => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? <HiEyeSlash /> : <HiEye />}</button>
          </div>
          {errors.password && <p id="password-error" className="err-msg" role="alert">{errors.password}</p>}
        </div>
        <button type="submit" disabled={loading} className="btn-primary btn-block auth-submit" aria-busy={loading}>
          {loading ? <><span className="spinner" aria-hidden="true" />Signing in…</> : <>Sign in to workspace <HiArrowRight /></>}
        </button>
      </form>

      <p className="auth-switch">New to NexusCommerce? <Link href="/signup" className="link-arrow">Create an account <HiArrowRight /></Link></p>

      <details className="demo-accounts">
        <summary>Explore with a demo account</summary>
        <div className="demo-list">
          {DEMO.map(([email, role]) => (
            <button key={email} type="button" onClick={() => setForm({ email, password: 'password123' })}>
              <span>{email}</span><span className="badge is-cap">{role}</span>
            </button>
          ))}
        </div>
      </details>
    </AuthLayout>
  );
}
