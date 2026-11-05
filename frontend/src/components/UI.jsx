import { useEffect, useRef } from 'react'

// ─── Progress Ring ────────────────────────────────────────────────────────────
export function ProgressRing({ pct, size = 72, strokeWidth = 5, label }) {
  const r      = (size - strokeWidth * 2) / 2
  const circ   = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ
  const color  = pct >= 80 ? '#12A05C' : pct >= 50 ? '#3D53E0' : '#B8790C'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="#E6EAF5" strokeWidth={strokeWidth} />
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={color} strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset .8s ease-out' }}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle"
          style={{ transform: 'rotate(90deg)', transformOrigin: '50% 50%',
            fill: '#121C3D', fontSize: size * 0.22, fontWeight: 600,
            fontFamily: 'Space Grotesk, sans-serif' }}>
          {Math.round(pct)}%
        </text>
      </svg>
      {label && (
        <span style={{ fontSize: 11, color: '#6A7699', textAlign: 'center' }}>{label}</span>
      )}
    </div>
  )
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
export function ProgressBar({ pct, height = 5, className = '' }) {
  const color = pct >= 80 ? '#12A05C' : pct >= 50 ? '#3D53E0' : '#B8790C'
  return (
    <div style={{ height, background: '#E6EAF5', borderRadius: height, overflow: 'hidden' }}
      className={className}>
      <div style={{
        height: '100%', width: `${pct}%`, background: color,
        borderRadius: height, transition: 'width .4s ease-out',
      }} />
    </div>
  )
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
export function StatusBadge({ pct, flag }) {
  if (flag === 'rework')  return <span className="badge badge-red">Rework</span>
  if (flag === 'stalled') return <span className="badge badge-amber">Stalled</span>
  if (pct >= 95)  return <span className="badge badge-green">Complete</span>
  if (pct >= 50)  return <span className="badge badge-amber">In progress</span>
  return <span className="badge badge-red">Delayed</span>
}

// ─── Metric Card ─────────────────────────────────────────────────────────────
export function MetricCard({ label, value, sub, subColor, icon, accent }) {
  return (
    <div className="card-sm" style={{
      borderColor: accent ? '#C2CBF8' : undefined,
      borderLeft:  accent ? '3px solid #3D53E0' : undefined,
    }}>
      <div style={{ fontSize: 11, color: '#9AA3C0', marginBottom: 10,
        textTransform: 'uppercase', letterSpacing: '.07em',
        display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon} {label}
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif',
        color: accent ? '#3D53E0' : '#121C3D', lineHeight: 1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: subColor || '#9AA3C0', marginTop: 5 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

// ─── Section Title ────────────────────────────────────────────────────────────
export function SectionTitle({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', marginBottom: 14 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#121C3D',
        fontFamily: 'Space Grotesk, sans-serif' }}>
        {children}
      </h3>
      {action}
    </div>
  )
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center',
      justifyContent: 'center', height: 120 }}>
      <div style={{
        width: 24, height: 24,
        border: '2.5px solid #E6EAF5',
        borderTopColor: '#DC3A3A',
        borderRadius: '50%',
        animation: 'spin .7s linear infinite',
      }} />
    </div>
  )
}

// ─── Trash icon ───────────────────────────────────────────────────────────────
// Drawn as SVG rather than the 🗑 emoji: emoji render differently on every OS
// and browser (colour, size, baseline), so they never sit cleanly in a row.
export function TrashIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────
// In-app replacement for window.confirm on destructive actions. Cancel is the
// focused default, so a stray Enter can't delete anything; Escape or clicking
// the backdrop also cancels. `busy` locks both buttons while the request runs.
export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', busy, onConfirm, onCancel }) {
  const cancelRef = useRef(null)
  // Latest props via a ref, so callers can pass inline functions without the
  // key listener being re-attached (and focus re-grabbed) on every render.
  const latest = useRef({ busy, onCancel })
  latest.current = { busy, onCancel }

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKey = e => {
      if (e.key === 'Escape' && !latest.current.busy) latest.current.onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div onClick={() => !busy && onCancel()} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg"
        className="card" onClick={e => e.stopPropagation()}
        style={{ maxWidth: 420, width: '90%', padding: 22 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
          <div style={{
            flexShrink: 0, width: 36, height: 36, borderRadius: '50%',
            background: 'var(--danger-bg)', color: 'var(--danger-text)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <TrashIcon size={17} />
          </div>
          <div>
            <div id="confirm-title" style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 16,
              color: 'var(--text-1)', marginBottom: 6 }}>
              {title}
            </div>
            <p id="confirm-msg" style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.5 }}>{message}</p>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button ref={cancelRef} className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{
            background: 'var(--danger-text)', color: '#FFFFFF', border: 'none',
            borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600,
            fontFamily: "'Space Grotesk', sans-serif", cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}>
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────
export function Empty({ message = 'No data yet', hint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: 120, gap: 6 }}>
      <div style={{ fontSize: 28 }}>📭</div>
      <div style={{ fontSize: 13, color: '#6A7699' }}>{message}</div>
      {hint && <div style={{ fontSize: 12, color: '#9AA3C0' }}>{hint}</div>}
    </div>
  )
}
