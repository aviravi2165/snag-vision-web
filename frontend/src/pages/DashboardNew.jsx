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
 * Date selector: UnitActivityProgress only stores the LATEST value per (Unit,
 * activity), so an "as of <date>" view can't be reconstructed client-side.
 * The history does exist server-side though — AIAnalysis rows are timestamped
 * — so picking a date refetches with ?as_of=YYYY-MM-DD and the backend
 * replays that history through the same mapping (see
 * services/mapping_service.py::unit_activity_matrix_as_of). Every KPI, chart
 * and the activity table derive from `cells`, so they all move together; no
 * value is interpolated between capture dates.
 *
 * The "Progress over time" trend comes from GET /projects/{id}/progress-series
 * — one measured point per capture date, replayed from the same history in a
 * single pass. It is fetched once per project and truncated client-side at the
 * selected date, so changing the date picker doesn't refetch it.
 *
 * Nothing here is fabricated: if an activity has never been scored for a
 * location it shows as "Cannot Assess" (null), not a guessed number.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useProject } from '../hooks/useProject'
import { getProgressMatrix, getProgressSeries, getIssues } from '../utils/api'
import { Spinner, Empty } from '../components/UI'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, LabelList,
} from 'recharts'

const COMPLETED_AT = 95   // >= this % counts as "Work Completed"

// Bar fill + track as specified: light blue on a very light blue track.
const BAR_FILL = '#60A5FA'
const BAR_TRACK = '#EAF2FF'

function statusFor(val) {
  if (val === null || val === undefined) return 'Cannot Assess'
  if (val >= COMPLETED_AT) return 'Work Completed'
  if (val > 0) return 'In Progress'
  return 'Not Started'
}
const STATUS_COLOR = {
  'Work Completed': '#16856F',
  'In Progress':     '#2F6FED',
  'Not Started':     '#D96A32',
  'Cannot Assess':   '#94A3B8',
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
  const [openIssues, setOpenIssues] = useState(0)   // open snags for the project

  // Capture dates this project can be rewound to (newest first, from the
  // server). `asOf` null = latest; the dropdown still shows the latest date
  // rather than a vague "Latest", so what you're looking at is never ambiguous.
  const [availableDates, setAvailableDates] = useState([])
  const [asOf, setAsOf] = useState(null)

  // Switching project must not leave the previous project's date selected.
  useEffect(() => { setAsOf(null); setAvailableDates([]) }, [selectedProject])

  // ── Load the pre-aggregated matrix — one call instead of the old
  // Floor→Unit→Room→getChangeDetection waterfall. Refetches on date change:
  // rewinding is a server-side replay of AIAnalysis history, not a client
  // filter (the matrix has no date dimension to filter on). ────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      setActivities([]); setLocations([]); setCells([])
      if (!selectedProject) return
      setLoading(true)
      try {
        const { data } = await getProgressMatrix(selectedProject.id, asOf)
        if (cancelled) return
        setActivities(data.activities)
        setLocations(data.locations)
        setCells(data.cells)
        setAvailableDates(data.available_dates || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [selectedProject, asOf])

  // ── Real progress history for the trend chart ────────────────────────────
  // Independent of `asOf`: the series is the full history, and the chart
  // truncates it client-side so changing the date doesn't refetch it.
  const [series, setSeries] = useState([])
  useEffect(() => {
    let cancelled = false
    async function loadSeries() {
      setSeries([])
      if (!selectedProject) return
      try {
        const { data } = await getProgressSeries(selectedProject.id)
        if (!cancelled) setSeries(data.series || [])
      } catch { /* trend is secondary — never block the dashboard */ }
    }
    loadSeries()
    return () => { cancelled = true }
  }, [selectedProject])

  // ── Open issues (snags) — status open or in_progress ─────────────────────
  useEffect(() => {
    let cancelled = false
    async function loadIssues() {
      if (!selectedProject) return
      try {
        const { data } = await getIssues({ project_id: selectedProject.id })
        if (cancelled) return
        const open = (data || []).filter(i => i.status === 'open' || i.status === 'in_progress').length
        setOpenIssues(open)
      } catch { /* issues are a bonus KPI — never block the dashboard */ }
    }
    loadIssues()
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
  // Overdue: target date already passed *as of the date being viewed* and the
  // work wasn't complete yet. Judged against `asOf` rather than today so a
  // rewound dashboard doesn't flag activities that still had time left then.
  const asOfOrToday = asOf || todayIso()
  const isDelayed = useCallback((name, pct) => {
    const target = targetDateFor(name)
    if (!target) return false
    return target < asOfOrToday && (pct === null || pct < COMPLETED_AT)
  }, [targetDateFor, asOfOrToday])

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
  // Activity-level: har activity ka saare locations ka average nikal ke status
  // decide karte hain — ek activity ko sirf ek baar count kiya jata hai.
  const kpis = useMemo(() => {
    let completed = 0, inProgress = 0, notStarted = 0, cannotAssess = 0, delayed = 0
    const numericValues = []
    activityNames.forEach(a => {
      const vals = (matrix[a] || []).map(c => c.value).filter(v => typeof v === 'number')
      const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null
      const status = statusFor(avg)
      if (status === 'Work Completed') completed++
      else if (status === 'In Progress') inProgress++
      else if (status === 'Not Started') notStarted++
      else cannotAssess++
      if (isDelayed(a, avg)) delayed++
      numericValues.push(...vals)
    })
    const overall = numericValues.length
      ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length
      : 0
    return {
      overall, completed, inProgress, notStarted, cannotAssess, delayed,
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
  // Completion by Location — ascending by unit number (A-101, A-102, A-103, …).
  const locationChart = useMemo(() => (
    filteredLocations
      .map(loc => {
        const vals = activityNames.map(a => cellValue(loc, a)).filter(v => typeof v === 'number')
        const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0
        return { name: locationLabel(loc), pct: Math.round(avg), unitNo: loc.unit_number }
      })
      .sort((a, b) => String(a.unitNo).localeCompare(String(b.unitNo), undefined, { numeric: true }))
  ), [filteredLocations, activityNames, cellValue])

  // ── Progress over time — one measured point per capture date ────────────
  // Re-weighted by each Unit's cell count (`n`) rather than averaging the
  // per-Unit averages, so this matches the Overall Completion KPI's
  // cell-level mean. Honours the Floor filter and stops at the selected date.
  const trendChart = useMemo(() => {
    const visibleUnitIds = new Set(filteredLocations.map(l => l.unit_id))
    return series
      .filter(pt => pt.date <= asOfOrToday)
      .map(pt => {
        const units = pt.units.filter(u => visibleUnitIds.has(u.unit_id))
        const cells = units.reduce((n, u) => n + u.n, 0)
        return {
          date: pt.date,
          label: new Date(pt.date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
          pct: cells ? Math.round((units.reduce((s, u) => s + u.pct * u.n, 0) / cells) * 10) / 10 : null,
        }
      })
  }, [series, filteredLocations, asOfOrToday])

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
    // Stamp the export with the date it reflects — an as-of CSV is otherwise
    // indistinguishable from a latest one.
    a.download = `${selectedProject?.name || 'project'}-activity-progress-${asOf || availableDates[0] || 'latest'}.csv`
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

      {/* Floor + date filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label className="label" style={{ margin: 0 }}>Floor</label>
        <select value={selectedFloor} onChange={e => setSelectedFloor(e.target.value)} style={{ width: 'auto' }}>
          <option value="all">All floors</option>
          {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
        </select>

        <label className="label" style={{ margin: '0 0 0 10px' }}>Progress as of</label>
        <select
          value={asOf || availableDates[0] || ''}
          onChange={e => setAsOf(e.target.value || null)}
          disabled={!availableDates.length}
          style={{ width: 'auto' }}
        >
          {availableDates.length === 0 ? (
            <option value="">No captures yet</option>
          ) : availableDates.map((d, i) => (
            <option key={d} value={d}>
              {new Date(d + 'T00:00:00').toLocaleDateString()}{i === 0 ? ' (latest)' : ''}
            </option>
          ))}
        </select>

        {/* Rewound views are easy to mistake for the live dashboard — say so. */}
        {asOf && availableDates[0] && asOf !== availableDates[0] && (
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#92400E', background: '#FEF3C7',
            border: '1px solid #FDE68A', borderRadius: 20, padding: '3px 10px',
          }}>
            Showing progress as of {new Date(asOf + 'T00:00:00').toLocaleDateString()} — not the latest
          </span>
        )}
      </div>

      {loading ? <Spinner /> : (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
            <KpiCard value={`${Math.round(kpis.overall)}%`} label="Overall Completion" color="#2F6FED" big />
            <KpiCard value={kpis.totalActivities} label="Total Activities" color="#7C3AED" />
            <KpiCard value={kpis.completed} label="Activities Completed" color="#16856F" />
            <KpiCard value={kpis.inProgress} label="In Progress" color="#2F6FED" />
            <KpiCard value={kpis.cannotAssess} label="Cannot Assess" color="#94A3B8" />
            <KpiCard value={openIssues} label="Open Issues (Snag)" color="#DC2626" />
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
                    <div style={{ height: 10, background: BAR_TRACK, borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${a.pct}%`, background: BAR_FILL, borderRadius: 4 }} />
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

          {/* Completion by Location + Weekly progress trend — side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'stretch' }}>
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
                        <Bar dataKey="pct" fill={BAR_FILL} radius={[4, 4, 0, 0]} barSize={24}>
                          <LabelList dataKey="pct" position="top"
                            formatter={v => `${v}%`}
                            style={{ fontSize: 10, fill: '#444', fontWeight: 600 }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13 }}>
                  Progress over time
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  {trendChart.length === 1 ? '1 capture' : `${trendChart.length} captures`}
                </span>
              </div>
              {trendChart.length === 0 ? (
                <Empty message="No captures yet" hint="The trend appears once photos have been analysed" />
              ) : (
                <div style={{ height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    {/* One point per capture date — the x-axis is deliberately
                        categorical: nothing is interpolated between captures. */}
                    <LineChart data={trendChart}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#EBEBEB" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#666' }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#666' }} axisLine={false} tickLine={false} />
                      <Tooltip content={<LightTooltip />} />
                      <Line
                        type="monotone" dataKey="pct"
                        stroke={BAR_FILL} strokeWidth={2.5}
                        dot={{ r: 4, fill: BAR_FILL, stroke: '#FFFFFF', strokeWidth: 2 }}
                        connectNulls={false}
                        activeDot={{ r: 6, fill: BAR_FILL }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
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
