// ─── Progress Ring ────────────────────────────────────────────────────────────
export function ProgressRing({ pct, size = 72, strokeWidth = 5, label }) {
  const r      = (size - strokeWidth * 2) / 2
  const circ   = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ
  const color  = pct >= 80 ? '#16856F' : pct >= 50 ? '#2F6FED' : '#D96A32'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="#E3EAF3" strokeWidth={strokeWidth} />
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={color} strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset .8s ease-out' }}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle"
          style={{ transform: 'rotate(90deg)', transformOrigin: '50% 50%',
            fill: '#13264B', fontSize: size * 0.22, fontWeight: 600,
            fontFamily: 'Space Grotesk, sans-serif' }}>
          {Math.round(pct)}%
        </text>
      </svg>
      {label && (
        <span style={{ fontSize: 11, color: '#666666', textAlign: 'center' }}>{label}</span>
      )}
    </div>
  )
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
export function ProgressBar({ pct, height = 5, className = '' }) {
  const color = pct >= 80 ? '#16856F' : pct >= 50 ? '#2F6FED' : '#D96A32'
  return (
    <div style={{ height, background: '#E3EAF3', borderRadius: height, overflow: 'hidden' }}
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
      borderColor: accent ? '#BFD5FF' : undefined,
      borderLeft:  accent ? '3px solid #2F6FED' : undefined,
    }}>
      <div style={{ fontSize: 11, color: '#999999', marginBottom: 10,
        textTransform: 'uppercase', letterSpacing: '.07em',
        display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon} {label}
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif',
        color: accent ? '#2F6FED' : '#13264B', lineHeight: 1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: subColor || '#999999', marginTop: 5 }}>
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
      <h3 style={{ fontSize: 13, fontWeight: 600, color: '#111111',
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
        border: '2.5px solid #E5E5E5',
        borderTopColor: '#D32F2F',
        borderRadius: '50%',
        animation: 'spin .7s linear infinite',
      }} />
    </div>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────
export function Empty({ message = 'No data yet', hint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: 120, gap: 6 }}>
      <div style={{ fontSize: 28 }}>📭</div>
      <div style={{ fontSize: 13, color: '#666666' }}>{message}</div>
      {hint && <div style={{ fontSize: 12, color: '#999999' }}>{hint}</div>}
    </div>
  )
}
