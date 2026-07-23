/**
 * DashboardNew.jsx — Activity-based Executive dashboard
 *
 * Reads a project's Activity Plan (Projects page → Activity Plan) and scores
 * every "Location" (a Floor + Room ID / Unit) against each activity, using
 * each Area's AI-analysis history (components keyed by the activity's slug —
 * see backend/services/gemini_service.py:slugify_activity). A location's
 * value for an activity is the average across its Areas' latest (or as-of a
 * selected date) value for that activity's key.
 *
 * Nothing here is fabricated: if an activity has never been scored for a
 * location it shows as "Cannot Assess" (null), not a guessed number.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { useProject } from '../hooks/useProject'
import {
  getActivities, getFloors, getUnits, getRooms, getChangeDetection,
} from '../utils/api'
import { Spinner, Empty } from '../components/UI'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts'

function slugifyActivity(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'activity'
}

// Pick the history entry current as of `dateKey` (or the latest if dateKey is null)
function historyAt(history, dateKey) {
  if (!history.length) return null
  if (!dateKey) return history[history.length - 1]
  let picked = null
  for (const h of history) {
    if (h.date.slice(0, 10) <= dateKey) picked = h
  }
  return picked
}

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

  const [activityPlan, setActivityPlan] = useState([])     // [{ name, target_date }], from Activity Plan
  const [locations,     setLocations]     = useState([])   // [{ floor, unit, rooms: [{room, history}] }]
  const [loading,       setLoading]       = useState(false)

  const activityNames = useMemo(() => activityPlan.map(a => a.name), [activityPlan])
  const targetDateFor = useCallback(
    (name) => activityPlan.find(a => a.name === name)?.target_date || null,
    [activityPlan]
  )
  // Overdue: has a target date in the past and isn't fully complete yet
  const isDelayed = useCallback((name, pct) => {
    const target = targetDateFor(name)
    if (!target) return false
    return target < todayIso() && (pct === null || pct < COMPLETED_AT)
  }, [targetDateFor])

  const [selectedFloor, setSelectedFloor] = useState('all')
  const [selectedDate,  setSelectedDate]  = useState(null)  // null = latest
  const [showActivityModal, setShowActivityModal] = useState(false)

  // ── Load Activity Plan + full Floor→Unit→Room→history tree for this project ──
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLocations([]); setActivityPlan([])
      if (!selectedProject) return
      setLoading(true)
      try {
        const [{ data: activities }, { data: floors }] = await Promise.all([
          getActivities(selectedProject.id),
          getFloors(selectedProject.id),
        ])
        if (cancelled) return
        // Older projects may still return plain name strings — normalize.
        setActivityPlan(activities.map(a => (typeof a === 'string' ? { name: a, target_date: null } : a)))

        const locs = []
        for (const floor of floors) {
          const { data: units } = await getUnits(floor.id)
          for (const unit of units) {
            const { data: rooms } = await getRooms(unit.id)
            const roomsWithHistory = await Promise.all(rooms.map(async room => {
              const history = await getChangeDetection(room.id).then(r => r.data).catch(() => [])
              return { room, history }
            }))
            locs.push({ floor, unit, rooms: roomsWithHistory })
          }
        }
        if (!cancelled) setLocations(locs)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [selectedProject])

  const floors = useMemo(() => {
    const seen = new Map()
    locations.forEach(({ floor }) => seen.set(floor.id, floor))
    return [...seen.values()].sort((a, b) => a.floor_number - b.floor_number)
  }, [locations])

  const availableDates = useMemo(() => {
    const set = new Set()
    locations.forEach(({ rooms }) => rooms.forEach(({ history }) =>
      history.forEach(h => set.add(h.date.slice(0, 10)))
    ))
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [locations])

  const filteredLocations = useMemo(() => (
    selectedFloor === 'all' ? locations : locations.filter(l => l.floor.id === selectedFloor)
  ), [locations, selectedFloor])

  // value for one location + one activity, at the selected date — null if never assessed
  const cellValue = useCallback((location, activityName) => {
    const slug = slugifyActivity(activityName)
    const vals = location.rooms
      .map(({ history }) => historyAt(history, selectedDate)?.components?.[slug])
      .filter(v => typeof v === 'number')
    if (!vals.length) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }, [selectedDate])

  const locationLabel = (l) => `Floor ${l.floor.floor_number} | ${l.unit.unit_number}`

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
          processedLocations.add(location.unit.id)
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

  // ── Weekly progress trend — overall completion % as of each available date ──
  const trendChart = useMemo(() => {
    const asc = [...availableDates].sort((a, b) => a.localeCompare(b))
    return asc.map(date => {
      const vals = []
      filteredLocations.forEach(loc => {
        activityNames.forEach(a => {
          const slug = slugifyActivity(a)
          loc.rooms.forEach(({ history }) => {
            const v = historyAt(history, date)?.components?.[slug]
            if (typeof v === 'number') vals.push(v)
          })
        })
      })
      const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null
      return { date: new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), pct: avg === null ? null : Math.round(avg) }
    })
  }, [availableDates, filteredLocations, activityNames])

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
          hint="Define one in Projects → Activity Plan to unlock this dashboard" />
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
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => toast('Coming soon')}>
            📅 Compare dates
          </button>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowActivityModal(true)}>
            📋 Activity details
          </button>
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={downloadCsv}>
            ⬇ Download CSV
          </button>
          <select value={selectedDate || ''} onChange={e => setSelectedDate(e.target.value || null)}
            style={{ width: 'auto', fontSize: 12 }}>
            <option value="">Latest</option>
            {availableDates.map(d => (
              <option key={d} value={d}>{new Date(d + 'T00:00:00').toLocaleDateString()}</option>
            ))}
          </select>
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

          {/* Weekly progress trend + Floor-wise progress */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="card">
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
                Weekly progress trend
              </div>
              {trendChart.length === 0 ? <Empty message="No history yet" /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={trendChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EBEBEB" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#666' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<LightTooltip />} />
                    <Line
                      type="monotone" dataKey="pct"
                      stroke="#D32F2F" strokeWidth={2.5}
                      dot={{ r: 4, fill: '#D32F2F', stroke: '#FFFFFF', strokeWidth: 2 }}
                      connectNulls activeDot={{ r: 6, fill: '#D32F2F' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="card">
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
                Completion by Location
              </div>
              {locationChart.length === 0 ? <Empty message="No locations yet" /> : (
                <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                  <div style={{ minWidth: Math.max(locationChart.length * 70, 100), height: 220 }}>
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
              {locations.map(l => <th key={l.unit.id}>{locationLabel(l)}</th>)}
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
                      <td key={l.unit.id}>
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

