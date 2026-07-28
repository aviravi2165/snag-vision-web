/**
 * DashboardNew.jsx — Activity-based Executive dashboard
 *
 * Reads the project's Activity Excel-derived Activity Plan and its
 * server-computed Unit × Activity progress matrix in a single call
 * (GET /projects/{id}/progress) — the backend aggregates
 * AIAnalysis.components (open-vocabulary, per services/gemini_service.py)
 * through the project's component→activity mapping
 * (services/mapping_service.py) into UnitActivityProgress rows, so this page
 * no longer walks Floor→Unit→Room→history itself.
 *
 * Grain note: a "location" here is a Unit (e.g. "A-101" — the Activity
 * Excel's actual "Room" column), whose value already combined-averages that
 * Unit's own Areas (Living/Bathroom, the `Room` model). Area-level breakdown
 * stays on the Floor View page — this dashboard never duplicates it.
 *
 * Trade-off worth knowing: UnitActivityProgress only stores the LATEST value
 * per (Unit, activity) — there is no per-date history in the new pipeline
 * (raw AIAnalysis.components are keyed by Gemini's own open vocabulary, not
 * by activity, so a historical "as of" comparison can't be reconstructed
 * client-side without re-implementing the mapping server does). The old
 * pipeline's date picker / multi-point trend are dropped rather than faked.
 *
 * Nothing here is fabricated: if an activity has never been scored for a
 * location it shows as "Cannot Assess" (null), not a guessed number.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useProject } from '../hooks/useProject'
import { getProgressMatrix } from '../utils/api'
import { Spinner, Empty } from '../components/UI'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts'

const COMPLETED_AT = 95   // >= this % counts as "Work Completed"

function statusFor(val) {
  if (val === null || val === undefined) return 'Cannot Assess'
  if (val >= COMPLETED_AT) return 'Work Completed'
  if (val > 0) return 'In Progress'
  return 'Not Started'
}
const STATUS_COLOR = {
  'Work Completed': '#22C55E',
  'In Progress':     '#F5A623',
  'Not Started':     '#EF4444',
  'Cannot Assess':   '#9CA3AF',
}

const LightTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #E5E5E5', borderRadius: 8,
      padding: '8px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
      <div style={{ fontSize: 11, color: '#666666', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111111' }}>{payload[0].value}%</div>
    </div>
  )
}

const todayIso = () => new Date().toISOString().slice(0, 10)

export default function DashboardNew() {
  const { selectedProject } = useProject()

  const [activities, setActivities] = useState([])   // [{id, name, start_date, target_date}]
  const [locations,  setLocations]  = useState([])    // [{floor_id, floor_number, unit_id, unit_number}]
  const [cells,      setCells]      = useState([])    // [{activity_id, unit_id, pct, confidence, last_analysed}]
  const [loading,    setLoading]    = useState(false)

  const [selectedFloor, setSelectedFloor] = useState('all')
  const [showActivityModal, setShowActivityModal] = useState(false)

  // ── Load the pre-aggregated matrix — one call instead of the old
  // Floor→Unit→Room→getChangeDetection waterfall. ──────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      setActivities([]); setLocations([]); setCells([])
      if (!selectedProject) return
      setLoading(true)
      try {
        const { data } = await getProgressMatrix(selectedProject.id)
        if (cancelled) return
        setActivities(data.activities)
        setLocations(data.locations)
        setCells(data.cells)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [selectedProject])

  const activityNames = useMemo(() => activities.map(a => a.name), [activities])
  const nameToId = useMemo(() => {
    const m = new Map()
    activities.forEach(a => m.set(a.name, a.id))
    return m
  }, [activities])
  const targetDateFor = useCallback(
    (name) => activities.find(a => a.name === name)?.target_date || null,
    [activities]
  )
  // Overdue: has a target date in the past and isn't fully complete yet
  const isDelayed = useCallback((name, pct) => {
    const target = targetDateFor(name)
    if (!target) return false
    return target < todayIso() && (pct === null || pct < COMPLETED_AT)
  }, [targetDateFor])

  const floors = useMemo(() => {
    const seen = new Map()
    locations.forEach(l => seen.set(l.floor_id, { id: l.floor_id, floor_number: l.floor_number }))
    return [...seen.values()].sort((a, b) => a.floor_number - b.floor_number)
  }, [locations])

  const filteredLocations = useMemo(() => (
    selectedFloor === 'all' ? locations : locations.filter(l => l.floor_id === selectedFloor)
  ), [locations, selectedFloor])

  const cellMap = useMemo(() => {
    const m = new Map()
    cells.forEach(c => m.set(`${c.activity_id}|${c.unit_id}`, c))
    return m
  }, [cells])

  // value for one location (Unit) + one activity — the backend already
  // combined-averages a Unit's own Areas (Living/Bathroom); this is a direct
  // lookup, not a client-side re-aggregation. null if never assessed.
  const cellValue = useCallback((location, activityName) => {
    const activityId = nameToId.get(activityName)
    if (!activityId) return null
    return cellMap.get(`${activityId}|${location.unit_id}`)?.pct ?? null
  }, [nameToId, cellMap])

  const locationLabel = (l) => `Floor ${l.floor_number} | ${l.unit_number}`

  // ── Matrix: activityName -> [{ location, value }] ────────────────────────
  const matrix = useMemo(() => {
    const m = {}
    activityNames.forEach(a => {
      m[a] = filteredLocations.map(loc => ({ location: loc, value: cellValue(loc, a) }))
    })
    return m
  }, [activityNames, filteredLocations, cellValue])

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let completed = 0, inProgress = 0, notStarted = 0, cannotAssess = 0, delayed = 0
    const numericValues = []
    const processedLocations = new Set()
    activityNames.forEach(a => {
      const vals = (matrix[a] || []).map(c => c.value).filter(v => typeof v === 'number')
      const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null
      if (isDelayed(a, avg)) delayed++
      matrix[a]?.forEach(({ location, value }) => {
        const status = statusFor(value)
        if (status === 'Work Completed') completed++
        else if (status === 'In Progress') inProgress++
        else if (status === 'Not Started') notStarted++
        else cannotAssess++
        if (typeof value === 'number') {
          numericValues.push(value)
          processedLocations.add(location.unit_id)
        }
      })
    })
    const overall = numericValues.length
      ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length
      : 0
    return {
      overall, completed, inProgress, notStarted, cannotAssess, delayed,
      locationsProcessed: processedLocations.size,
      totalActivities: activityNames.length,
    }
  }, [activityNames, matrix, isDelayed])

  // ── Activity Completion (%) — per-activity average across locations ─────
  const activityCompletionChart = useMemo(() => (
    activityNames.map(a => {
      const vals = (matrix[a] || []).map(c => c.value).filter(v => typeof v === 'number')
      const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null
      return {
        name: a, pct: avg === null ? 0 : Math.round(avg * 100) / 100, hasData: vals.length > 0,
        targetDate: targetDateFor(a), delayed: isDelayed(a, avg),
      }
    }).sort((a, b) => b.pct - a.pct)
  ), [activityNames, matrix, targetDateFor, isDelayed])

  // ── Completion by Location — per-location average across activities ─────
  const locationChart = useMemo(() => (
    filteredLocations.map(loc => {
      const vals = activityNames.map(a => cellValue(loc, a)).filter(v => typeof v === 'number')
      const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0
      return { name: locationLabel(loc), pct: Math.round(avg) }
    })
  ), [filteredLocations, activityNames, cellValue])

  const summaryData = [
    { name: 'Work Completed', value: kpis.completed, color: STATUS_COLOR['Work Completed'] },
    { name: 'In Progress',    value: kpis.inProgress, color: STATUS_COLOR['In Progress'] },
    { name: 'Not Started',    value: kpis.notStarted, color: STATUS_COLOR['Not Started'] },
  ].filter(d => d.value > 0)

  // ── CSV export of the full activity x location matrix ───────────────────
  const downloadCsv = () => {
    const header = ['Activity', ...filteredLocations.map(locationLabel)]
    const rows = activityNames.map(a => [
      a, ...(matrix[a] || []).map(c => (c.value === null ? '' : Math.round(c.value * 100) / 100)),
    ])
    const csv = [header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedProject?.name || 'project'}-activity-progress.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!selectedProject) {
    return <div className="card"><Empty message="No active project" hint="Select a project from the sidebar" /></div>
  }
  if (!activityNames.length && !loading) {
    return (
      <div className="card">
        <Empty message="No Activity Plan set for this project"
          hint="Upload an Activity Excel in Projects → Activity Plan to unlock this dashboard" />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 2 }}>
            {selectedProject.name} — Monitoring
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowActivityModal(true)}>
            📋 Activity details
          </button>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={downloadCsv}>
            ⬇ Download CSV
          </button>
        </div>
      </div>

      {/* Floor filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label className="label" style={{ margin: 0 }}>Floor</label>
        <select value={selectedFloor} onChange={e => setSelectedFloor(e.target.value)} style={{ width: 'auto' }}>
          <option value="all">All floors</option>
          {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
        </select>
      </div>

      {loading ? <Spinner /> : (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
            <KpiCard value={`${Math.round(kpis.overall)}%`} label="Overall Completion" color="#D32F2F" big />
            <KpiCard value={kpis.completed} label="Work Completed" color="#22C55E" />
            <KpiCard value={kpis.inProgress} label="In Progress" color="#F5A623" />
            <KpiCard value={kpis.notStarted} label="Not Started" color="#EF4444" />
            <KpiCard value={kpis.cannotAssess} label="Cannot Assess" color="#9CA3AF" />
            <KpiCard value={kpis.delayed} label="Delayed" color="#DC2626" />
            <KpiCard value={kpis.locationsProcessed} label="Locations Processed" color="#2563EB" />
            <KpiCard value={kpis.totalActivities} label="Total Activities" color="#7C3AED" />
          </div>

          {/* Activity completion + Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
            <div className="card">
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
                Activity Completion (%)
              </div>
              <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activityCompletionChart.map(a => (
                  <div key={a.name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                      <span style={{ color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                        {a.name}
                        {a.targetDate && (
                          <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)', marginLeft: 6 }}>
                            (target {new Date(a.targetDate + 'T00:00:00').toLocaleDateString()})
                          </span>
                        )}
                        {a.delayed && (
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#DC2626' }}>⚠ DELAYED</span>
                        )}
                      </span>
                      <span style={{ fontWeight: 600 }}>{a.hasData ? `${a.pct}%` : '—'}</span>
                    </div>
                    <div style={{ height: 10, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${a.pct}%`, background: a.delayed ? '#EF4444' : '#F5C842', borderRadius: 4 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
                Summary
              </div>
              {summaryData.length === 0 ? <Empty message="No data yet" /> : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={summaryData} dataKey="value" innerRadius={55} outerRadius={80} paddingAngle={2}>
                        {summaryData.map(d => <Cell key={d.name} fill={d.color} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 8 }}>
                    {summaryData.map(d => (
                      <span key={d.name} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20,
                        background: d.color + '22', color: d.color, fontWeight: 600 }}>
                        {d.name}: {d.value}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Completion by Location */}
          <div className="card">
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
              Completion by Location
            </div>
            {locationChart.length === 0 ? <Empty message="No locations yet" /> : (
              <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                <div style={{ minWidth: Math.max(locationChart.length * 70, 100), height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={locationChart}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#EBEBEB" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#666' }} axisLine={false} tickLine={false}
                        angle={-40} textAnchor="end" height={70} interval={0} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#666' }} axisLine={false} tickLine={false} />
                      <Tooltip content={<LightTooltip />} />
                      <Bar dataKey="pct" fill="#2563EB" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Activity details modal ── */}
      {showActivityModal && (
        <ActivityDetailsModal
          activityNames={activityNames} locations={filteredLocations}
          cellValue={cellValue} locationLabel={locationLabel}
          targetDateFor={targetDateFor} isDelayed={isDelayed}
          onClose={() => setShowActivityModal(false)}
        />
      )}
    </div>
  )
}

function KpiCard({ value, label, color, big }) {
  return (
    <div className="card" style={{ padding: '14px 12px' }}>
      <div style={{ fontSize: big ? 26 : 22, fontWeight: 700, fontFamily: 'Space Grotesk', color }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

function ModalShell({ title, onClose, width = 900, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 14, width, maxWidth: '95vw', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid #E5E5E5' }}>
          <span style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20 }}>✕</button>
        </div>
        <div style={{ padding: 20, overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  )
}

function ActivityDetailsModal({ activityNames, locations, cellValue, locationLabel, targetDateFor, isDelayed, onClose }) {
  const [filter, setFilter] = useState('All')
  const [search, setSearch] = useState('')

  const rows = activityNames
    .filter(a => a.toLowerCase().includes(search.toLowerCase()))
    .filter(a => {
      if (filter === 'All') return true
      const numericVals = locations.map(l => cellValue(l, a)).filter(v => typeof v === 'number')
      const overall = numericVals.length
        ? numericVals.reduce((s, v) => s + v, 0) / numericVals.length
        : null
      return statusFor(overall) === filter
    })

  return (
    <ModalShell title="Activity details" onClose={onClose} width={1100}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['All', 'Work Completed', 'In Progress', 'Not Started', 'Cannot Assess'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '5px 10px', borderRadius: 20, fontSize: 11, cursor: 'pointer',
              border: `1px solid ${filter === f ? '#111' : '#E5E5E5'}`,
              background: filter === f ? '#111' : '#fff', color: filter === f ? '#fff' : '#666',
            }}>{f}</button>
          ))}
        </div>
        <input placeholder="Search activity…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: 200 }} />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Target Date</th>
              {locations.map(l => <th key={l.unit_id}>{locationLabel(l)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(a => {
              const numericVals = locations.map(l => cellValue(l, a)).filter(v => typeof v === 'number')
              const overall = numericVals.length
                ? numericVals.reduce((s, v) => s + v, 0) / numericVals.length
                : null
              const target = targetDateFor(a)
              const delayed = isDelayed(a, overall)
              return (
                <tr key={a}>
                  <td style={{ fontWeight: 600 }}>
                    {a}
                    {delayed && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#DC2626' }}>⚠ DELAYED</span>}
                  </td>
                  <td style={{ fontSize: 12, color: delayed ? '#DC2626' : 'var(--text-3)', fontWeight: delayed ? 700 : 400 }}>
                    {target ? new Date(target + 'T00:00:00').toLocaleDateString() : '—'}
                  </td>
                  {locations.map(l => {
                    const v = cellValue(l, a)
                    const status = statusFor(v)
                    return (
                      <td key={l.unit_id}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                          background: STATUS_COLOR[status] + '22', color: STATUS_COLOR[status] }}>
                          {v === null ? 'N/A' : `${Math.round(v)}%`}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={locations.length + 2} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>
                No activities match this filter
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </ModalShell>
  )
}
