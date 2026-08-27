import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import toast from 'react-hot-toast'

const FEATURES = [
  'AI Progress Analysis',
  'Floor-wise Tracking',
  '360° Site Capture',
  'Panorama Comparison',
]

export default function Login() {
  const { login } = useAuth()
  const navigate  = useNavigate()
  const [form,    setForm]    = useState({ email: '', password: '' })
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true)
    try { await login(form.email, form.password); navigate('/dashboard') }
    catch { toast.error('Invalid credentials') }
    finally { setLoading(false) }
  }

  return (
    <div className="login-split" style={{ minHeight: '100vh', display: 'flex' }}>

      {/* ── Left brand panel ── */}
      <div className="login-brand" style={{
        flex: 1, background: '#181B2B', color: '#FFFFFF',
        padding: '56px 64px', display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', position: 'relative',
        borderRight: '2px solid #DC3A3A',
      }}>
        <div>
          {/* Brand */}
          <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700,
            fontSize: 34, letterSpacing: '-0.03em', lineHeight: 1.3, paddingBottom: 4,
            marginBottom: 4, color: '#FFFFFF' }}>
            VESTIGIA
          </div>
          <div style={{ fontSize: 13, color: '#D2D9EC', fontStyle: 'italic', marginBottom: 8 }}>
            The Verifiable Record of Execution.
          </div>
          <div style={{ fontSize: 11, color: '#6A7699', letterSpacing: '.05em', marginBottom: 40 }}>
            By I.EVO
          </div>

          {/* Feature list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {FEATURES.map(f => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: '#E6EAF5' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#DC3A3A', flexShrink: 0 }} />
                {f}
              </div>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 11, color: '#333F6A', letterSpacing: '.05em' }}>
          I.EVO — INTERIOR CONSTRUCTION MONITORING
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="login-form-side" style={{
        flex: 1, background: '#F4F6FC',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div style={{ background: '#FFFFFF', border: '1px solid #E6EAF5',
          borderRadius: 16, padding: '40px 36px', width: 400, maxWidth: '100%',
          boxShadow: '0 4px 24px rgba(0,0,0,0.07)' }}>

          <h2 style={{ fontFamily: 'Space Grotesk, sans-serif', fontSize: 26, fontWeight: 700,
            color: '#121C3D', marginBottom: 4 }}>Welcome back</h2>
          <p style={{ fontSize: 13, color: '#6A7699', marginBottom: 28 }}>
            Sign in to your account
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="label">Email</label>
              <input type="email" placeholder="you@ievo.in" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div>
              <label className="label">Password</label>
              <input type="password" placeholder="••••••••" value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })} required />
            </div>
            <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4, padding: '11px' }}>
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>

          <div style={{ marginTop: 20, padding: '10px 14px',
            background: '#F4F6FC', borderRadius: 8,
            fontSize: 12, color: '#6A7699', lineHeight: 1.6 }}>
            <span style={{ color: '#333F6A', fontWeight: 500 }}>Demo:</span>{' '}
            admin@ievo.in / password123
          </div>

          <div style={{ marginTop: 16, textAlign: 'center', fontSize: 13, color: '#6A7699' }}>
            Don't have an account?{' '}
            <Link to="/register" style={{ color: '#DC3A3A', fontWeight: 500 }}>Create one</Link>
          </div>
        </div>
      </div>

      {/* Hide brand panel on small screens */}
      <style>{`
        @media (max-width: 820px) {
          .login-brand { display: none !important; }
        }
      `}</style>
    </div>
  )
}
