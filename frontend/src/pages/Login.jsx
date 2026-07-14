import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import toast from 'react-hot-toast'

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
    <div style={{ minHeight: '100vh', background: '#F8F7F4',
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

      {/* Subtle grid */}
      <div style={{ position: 'fixed', inset: 0, opacity: .03,
        backgroundImage: 'linear-gradient(#111 1px, transparent 1px), linear-gradient(90deg, #111 1px, transparent 1px)',
        backgroundSize: '32px 32px', pointerEvents: 'none' }} />

      <div style={{ background: '#FFFFFF', border: '1px solid #E5E5E5',
        borderRadius: 16, padding: '36px 32px', width: 380, maxWidth: '95vw',
        position: 'relative', boxShadow: '0 4px 24px rgba(0,0,0,0.07)' }}>

        {/* Red top accent line */}
        <div style={{ position: 'absolute', top: -1, left: '50%',
          transform: 'translateX(-50%)', width: 80, height: 2,
          background: 'linear-gradient(90deg, transparent, #D32F2F, transparent)',
          borderRadius: 2 }} />

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: '#D32F2F',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'Space Grotesk, sans-serif', fontWeight: 800,
            fontSize: 16, color: '#FFFFFF' }}>S</div>
          <div>
            <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700,
              fontSize: 17, color: '#111111', letterSpacing: '-0.03em' }}>SnagVision</div>
            <div style={{ fontSize: 10, color: '#999999', letterSpacing: '.06em',
              textTransform: 'uppercase' }}>by IEVO</div>
          </div>
        </div>

        <h2 style={{ fontSize: 18, marginBottom: 4, color: '#111111' }}>Sign in</h2>
        <p style={{ fontSize: 13, color: '#666666', marginBottom: 24 }}>
          Interior Construction Monitoring
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4 }}>
            {loading ? 'Signing in…' : 'Sign in →'}
          </button>
        </form>

        <div style={{ marginTop: 20, padding: '10px 14px',
          background: '#F8F7F4', borderRadius: 8,
          fontSize: 12, color: '#666666', lineHeight: 1.6 }}>
          <span style={{ color: '#444444', fontWeight: 500 }}>Demo:</span>{' '}
          admin@ievo.in / password123
        </div>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 13, color: '#666666' }}>
          Don't have an account?{' '}
          <Link to="/register" style={{ color: '#D32F2F', fontWeight: 500 }}>Create one</Link>
        </div>
      </div>
    </div>
  )
}
