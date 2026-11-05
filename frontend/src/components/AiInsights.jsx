/**
 * AI inspection findings — everything the photo analysis reports beyond a
 * progress percentage: defects (snags) with severity / location / fix, safety
 * issues, pending work, materials, housekeeping and photo quality.
 *
 *   <AiInsights projectId>      project-wide, from each room's latest analysis (Dashboard)
 *   <AnalysisFindings details>  one room's latest analysis (AI analysis page)
 *
 * Severity colours are inline CSS variables on purpose: class names assembled at
 * runtime (`sev-${level}`) are dropped by Tailwind's purge — the same trap that
 * once left the project status badges uncoloured.
 */
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProjectInsights } from '../utils/api'
import { Spinner, Empty } from './UI'

export const SEVERITY_STYLE = {
  critical: { label: 'Critical', bg: 'var(--danger-strong)', color: '#FFFFFF', border: 'var(--danger-strong)' },
  high:     { label: 'High',     bg: 'var(--danger-bg)',     color: 'var(--danger-text)',  border: 'var(--danger-border)' },
  medium:   { label: 'Medium',   bg: 'var(--warning-bg)',    color: 'var(--warning-text)', border: 'var(--warning-border)' },
  low:      { label: 'Low',      bg: 'var(--bg-hover)',      color: 'var(--text-3)',       border: 'var(--border-strong)' },
}
const SEVERITIES = ['critical', 'high', 'medium', 'low']

export function SeverityPill({ severity }) {
  const s = SEVERITY_STYLE[severity] || SEVERITY_STYLE.medium
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 20,
      fontSize: 10.5, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}

const HOUSEKEEPING = {
  clean:     { label: 'Site clean',     bg: 'var(--success-bg)', color: 'var(--success-text)', border: 'var(--success-border)' },
  moderate:  { label: 'Some clutter',   bg: 'var(--warning-bg)', color: 'var(--warning-text)', border: 'var(--warning-border)' },
  cluttered: { label: 'Cluttered',      bg: 'var(--danger-bg)',  color: 'var(--danger-text)',  border: 'var(--danger-border)' },
}

function Chip({ children, style, title }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 20, fontSize: 11,
      fontWeight: 500, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
      color: 'var(--text-2)', ...style,
    }}>{children}</span>
  )
}

const humanise = s => (s || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

// The API sends UTC timestamps without a zone suffix; without one the browser
// reads them as local time and shows the wrong date near midnight.
const toDate = iso => new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
const fmtDate = iso => (iso ? toDate(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

const SECTION_LABEL = {
  fontSize: 10.5, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase',
  color: 'var(--text-3)', marginBottom: 8,
}

function Thumb({ src }) {
  if (!src) return null
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open photo" style={{ flexShrink: 0 }}>
      <img src={src} alt="" loading="lazy" style={{
        width: 72, height: 54, objectFit: 'cover', borderRadius: 6, display: 'block',
        border: '1px solid var(--border)', background: 'var(--bg-hover)',
      }} />
    </a>
  )
}

// One defect or safety row — shared by the project list and the per-room panel.
function FindingRow({ severity, title, roomPath, description, location, fix, imageUrl }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-dim)' }}>
      <Thumb src={imageUrl} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
          <SeverityPill severity={severity} />
          {title && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{title}</span>}
          {roomPath && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{roomPath}</span>}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{description}</div>
        {location && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}><b style={{ fontWeight: 600 }}>Where:</b> {location}</div>}
        {fix && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}><b style={{ fontWeight: 600 }}>Suggested fix:</b> {fix}</div>}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }) {
  return (
    <div className="card-sm" style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 24, lineHeight: 1, color: color || 'var(--text-1)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

const PAGE = 6

function ShowMore({ total, shown, onClick }) {
  if (total <= shown) return null
  return (
    <button className="btn-ghost" onClick={onClick} style={{ fontSize: 12, marginTop: 10 }}>
      Show all {total}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Project-wide (Dashboard)
// ─────────────────────────────────────────────────────────────────────────────
/** Fetches a project's insights. Called once by the Dashboard, which hands the
 *  result to <AiInsights> and also uses `data.trend` for its progress chart. */
export function useProjectInsights(projectId) {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')       // loading | ready | error

  const load = useCallback(async (isCancelled = () => false) => {
    if (!projectId) return
    setState('loading')
    try {
      const { data } = await getProjectInsights(projectId)
      if (isCancelled()) return
      setData(data)
      setState('ready')
    } catch {
      if (!isCancelled()) setState('error')
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setData(null)
    load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  return { data, state, reload: () => load() }
}

// Render with key={projectId} so the open tab / expanded lists reset per project.
export function AiInsights({ insights }) {
  const navigate = useNavigate()
  const { data, state, reload } = insights
  const [tab, setTab] = useState(null)                // defects | safety | rooms
  const [expanded, setExpanded] = useState({})

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
      <div>
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14 }}>AI Site Inspection</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
          What the AI found in each room's latest photo
          {data?.last_analysed_at && <> · last analysed {fmtDate(data.last_analysed_at)}</>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={reload} disabled={state === 'loading'}>Refresh</button>
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => navigate('/analysis')}>Room details →</button>
      </div>
    </div>
  )

  if (state === 'loading' && !data) return <div className="card">{header}<Spinner /></div>
  if (state === 'error') {
    return <div className="card">{header}<div style={{ fontSize: 13, color: 'var(--text-3)' }}>Couldn't load AI findings. Try Refresh.</div></div>
  }
  if (!data || data.analysed_rooms === 0) {
    return (
      <div className="card">
        {header}
        <Empty message="No AI inspection yet" hint="Upload photos, then press Start AI Analysis on the Upload page" />
      </div>
    )
  }

  const activeTab = tab || (data.defect_count ? 'defects' : data.safety_count ? 'safety' : 'rooms')
  const sc = data.severity_counts
  const urgent = sc.critical + sc.high
  const tabs = [
    { id: 'defects', label: `Defects (${data.defect_count})` },
    { id: 'safety',  label: `Safety (${data.safety_count})` },
    { id: 'rooms',   label: `Rooms (${data.analysed_rooms})` },
  ]
  const list = (key, items) => (expanded[key] ? items : items.slice(0, PAGE))

  return (
    <div className="card">
      {header}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <StatCard label="Rooms inspected" value={`${data.analysed_rooms} / ${data.total_rooms}`}
          sub={data.analysed_rooms < data.total_rooms ? `${data.total_rooms - data.analysed_rooms} not photographed yet` : 'All rooms covered'} />
        <StatCard label="AI snags found" value={data.defect_count}
          color={urgent ? 'var(--danger-text)' : undefined}
          sub={data.defect_count ? `${urgent} need urgent attention` : 'No defects detected'} />
        <StatCard label="Safety issues" value={data.safety_count} color={data.safety_count ? 'var(--warning-text)' : undefined}
          sub={data.safety_count ? 'Review before work continues' : 'None detected'} />
      </div>

      {data.defect_count > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {SEVERITIES.filter(s => sc[s] > 0).map(s => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <SeverityPill severity={s} /><span style={{ fontSize: 12, fontWeight: 600 }}>{sc[s]}</span>
            </span>
          ))}
        </div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={activeTab === t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px', fontSize: 12.5, fontWeight: 600,
            color: activeTab === t.id ? 'var(--accent)' : 'var(--text-3)',
            borderBottom: `2px solid ${activeTab === t.id ? 'var(--accent)' : 'transparent'}`, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {activeTab === 'defects' && (
        data.defects.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '16px 0' }}>No defects detected in the latest photos.</div>
          : <>
              {list('d', data.defects).map((d, i) => (
                <FindingRow key={i} severity={d.severity} title={humanise(d.type)} roomPath={d.room_path}
                  description={d.description} location={d.location} fix={d.recommendation} imageUrl={d.image_url} />
              ))}
              <ShowMore total={data.defects.length} shown={list('d', data.defects).length} onClick={() => setExpanded(e => ({ ...e, d: true }))} />
            </>
      )}

      {activeTab === 'safety' && (
        data.safety_issues.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '16px 0' }}>No safety issues detected.</div>
          : <>
              {list('s', data.safety_issues).map((s, i) => (
                <FindingRow key={i} severity={s.severity} roomPath={s.room_path} description={s.description} />
              ))}
              <ShowMore total={data.safety_issues.length} shown={list('s', data.safety_issues).length} onClick={() => setExpanded(e => ({ ...e, s: true }))} />
            </>
      )}

      {activeTab === 'rooms' && (
        <>
          {list('r', data.rooms).map(r => {
            const hk = HOUSEKEEPING[r.housekeeping]
            return (
              <div key={r.room_id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-dim)' }}>
                <Thumb src={r.image_url} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{r.room_path}</span>
                    <Chip>{Math.round(r.overall_pct)}% complete</Chip>
                    {r.room_type && <Chip>{humanise(r.room_type)}</Chip>}
                    {hk && <Chip style={{ background: hk.bg, color: hk.color, borderColor: hk.border }}>{hk.label}</Chip>}
                    {r.defect_count > 0 && <SeverityPill severity={r.worst_severity} />}
                    {r.defect_count > 0 && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.defect_count} snag{r.defect_count === 1 ? '' : 's'}</span>}
                    {!r.image_usable && <Chip title="The photo was too unclear to judge reliably" style={{ background: 'var(--warning-bg)', color: 'var(--warning-text)', borderColor: 'var(--warning-border)' }}>Retake photo</Chip>}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{r.summary || 'No summary available.'}</div>
                </div>
              </div>
            )
          })}
          <ShowMore total={data.rooms.length} shown={list('r', data.rooms).length} onClick={() => setExpanded(e => ({ ...e, r: true }))} />
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// One room's latest analysis (AI analysis page)
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_LABEL = {
  completed:   { label: 'Completed',   bg: 'var(--success-bg)', color: 'var(--success-text)', border: 'var(--success-border)' },
  in_progress: { label: 'In progress', bg: 'var(--info-bg)',    color: 'var(--info-text)',    border: 'var(--info-border)' },
  not_started: { label: 'Not started', bg: 'var(--bg-hover)',   color: 'var(--text-3)',       border: 'var(--border-strong)' },
}

export function AnalysisFindings({ details, components }) {
  if (!details) {
    return (
      <div className="card" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
        Detailed findings (defects, safety, pending work) are recorded for analyses run after this feature was added.
        Run <b>Start AI Analysis</b> again for this walkthrough to generate them.
      </div>
    )
  }

  const quality = details.image_quality || {}
  const hk = HOUSEKEEPING[details.housekeeping]
  const defects = [...(details.defects || [])].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
  const safety = details.safety_issues || []
  const pending = details.pending_work || []
  const materials = details.materials_finishes || []
  const comps = Object.entries(components || {}).filter(([, v]) => v && typeof v === 'object' && v.note)

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14 }}>AI findings</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {details.room_type && <Chip>{humanise(details.room_type)}</Chip>}
          {hk && <Chip style={{ background: hk.bg, color: hk.color, borderColor: hk.border }}>{hk.label}</Chip>}
          {details.overall_confidence != null && <Chip title="How sure the AI is of its overall estimate">{Math.round(details.overall_confidence * 100)}% confident</Chip>}
        </div>
      </div>

      {(quality.usable === false || (quality.issues || []).length > 0) && (
        <div style={{
          fontSize: 12.5, padding: '9px 12px', borderRadius: 8, lineHeight: 1.5,
          background: 'var(--warning-bg)', color: 'var(--warning-text)', border: '1px solid var(--warning-border)',
        }}>
          <b>{quality.usable === false ? 'This photo was too unclear to judge reliably.' : 'Photo quality note:'}</b>{' '}
          {(quality.issues || []).join(', ')}
          {quality.usable === false && ' Retake it for a dependable result.'}
        </div>
      )}

      <div>
        <div style={SECTION_LABEL}>Defects / snags ({defects.length})</div>
        {defects.length === 0
          ? <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No defects detected.</div>
          : defects.map((d, i) => (
              <FindingRow key={i} severity={d.severity} title={humanise(d.type)}
                description={d.description} location={d.location} fix={d.recommendation} />
            ))}
      </div>

      {safety.length > 0 && (
        <div>
          <div style={SECTION_LABEL}>Safety issues ({safety.length})</div>
          {safety.map((s, i) => <FindingRow key={i} severity={s.severity} description={s.description} />)}
        </div>
      )}

      {pending.length > 0 && (
        <div>
          <div style={SECTION_LABEL}>Work still to do</div>
          <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
            {pending.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {materials.length > 0 && (
        <div>
          <div style={SECTION_LABEL}>Materials &amp; finishes seen</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{materials.map((m, i) => <Chip key={i}>{m}</Chip>)}</div>
        </div>
      )}

      {comps.length > 0 && (
        <div>
          <div style={SECTION_LABEL}>Element by element</div>
          {comps.map(([name, v]) => {
            const st = STATUS_LABEL[v.status] || STATUS_LABEL.in_progress
            return (
              <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--border-dim)' }}>
                <div style={{ width: 160, flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text-1)' }}>{humanise(name)}</div>
                <Chip style={{ background: st.bg, color: st.color, borderColor: st.border, flexShrink: 0 }}>{st.label} · {Math.round(v.pct)}%</Chip>
                <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{v.note}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
