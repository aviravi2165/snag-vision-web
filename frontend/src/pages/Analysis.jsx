import { useState, useEffect } from 'react'
import { getFloors, getUnits, getRooms, getRoomAnalysis, getChangeDetection } from '../utils/api'
import { useProject } from '../hooks/useProject'   // ← global project context
import { Spinner, ProgressBar, StatusBadge, ProgressRing, Empty, SectionTitle } from '../components/UI'
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { STANDARD_ACTIVITIES } from '../utils/standardActivities'

const CT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--amber)' }}>{payload[0].value}%</div>
    </div>
  )
}

export default function AnalysisPage() {
  // ✅ Global project from sidebar switcher — no local project state needed
  const { selectedProject } = useProject()

  const [floors, setFloors]   = useState([])
  const [units, setUnits]     = useState([])
  const [rooms, setRooms]     = useState([])

  const [selFloor, setSelFloor] = useState(null)
  const [selUnit,  setSelUnit]  = useState(null)
  const [selRoom,  setSelRoom]  = useState(null)

  const [analysis, setAnalysis] = useState(null)
  const [history,  setHistory]  = useState([])
  const [loading,  setLoading]  = useState(false)

  // ✅ When global project changes → reset everything and reload floors
  useEffect(() => {
    if (!selectedProject) return
    setFloors([]); setUnits([]); setRooms([])
    setSelFloor(null); setSelUnit(null); setSelRoom(null)
    setAnalysis(null); setHistory([])

    getFloors(selectedProject.id).then(({ data }) => {
      setFloors(data)
      setSelFloor(data[0]?.id || null)
    })
  }, [selectedProject])

  // Cascade: floor → units
  useEffect(() => {
    if (!selFloor) { setUnits([]); setSelUnit(null); return }
    getUnits(selFloor).then(({ data }) => {
      setUnits(data)
      setSelUnit(data[0]?.id || null)
    })
  }, [selFloor])

  // Cascade: unit → rooms
  useEffect(() => {
    if (!selUnit) { setRooms([]); setSelRoom(null); return }
    getRooms(selUnit).then(({ data }) => {
      setRooms(data)
      setSelRoom(data[0]?.id || null)
    })
  }, [selUnit])

  // Load analysis for selected room
  useEffect(() => {
    if (!selRoom) { setAnalysis(null); setHistory([]); return }
    setLoading(true)
    Promise.all([getRoomAnalysis(selRoom), getChangeDetection(selRoom)])
      .then(([a, h]) => { setAnalysis(a.data); setHistory(h.data) })
      .catch(() => { setAnalysis(null); setHistory([]) })
      .finally(() => setLoading(false))
  }, [selRoom])

  // Mapped breakdown: raw Gemini components rolled into the STANDARD
  // 12-category catalog server-side (the `mapped` field). Always render the
  // full standard list — categories with no evidence show '—', raw component
  // keys are never displayed.
  const mapped = analysis?.mapped || []
  const mappedByName = Object.fromEntries(mapped.map(m => [m.name, m.pct]))
  const activityList = STANDARD_ACTIVITIES.map(name => ({ name, pct: mappedByName[name] ?? null }))
  const radarData  = activityList
    .filter(a => a.pct !== null)
    .map(({ name, pct }) => ({ s: name, v: Math.round(pct) }))
  const histChart = history.map((h, i) => ({ visit: `V${i + 1}`, pct: Math.round(h.overall_pct) }))

  // Labels for breadcrumb
  const selFloorLabel = floors.find(f => f.id === selFloor)
  const selUnitLabel  = units.find(u => u.id === selUnit)?.unit_number
  const selRoomLabel  = rooms.find(r => r.id === selRoom)?.name

  return (
    <div style={{ padding: 28, maxWidth: 1000 }}>
      <div style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700 }}>AI analysis</h1>
      </div>

      {/* ✅ Only Floor, Unit, Room dropdowns — Project comes from sidebar */}
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div>
            <label className="label">Floor</label>
            <select value={selFloor || ''} onChange={e => setSelFloor(e.target.value)} disabled={!floors.length}>
              {floors.length === 0 && <option value="">No floors</option>}
              {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Unit</label>
            <select value={selUnit || ''} onChange={e => setSelUnit(e.target.value)} disabled={!units.length}>
              {units.length === 0 && <option value="">No units</option>}
              {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Room</label>
            <select value={selRoom || ''} onChange={e => setSelRoom(e.target.value)} disabled={!rooms.length}>
              {rooms.length === 0 && <option value="">No rooms</option>}
              {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
        </div>

        {/* ✅ Breadcrumb — always shows exactly what you are viewing */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14,
          fontSize: 12, color: 'var(--text-3)', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--amber)', fontWeight: 600 }}>
            {selectedProject?.name || '—'}
          </span>
          {selFloorLabel && <><span>›</span><span>Floor {selFloorLabel.floor_number}</span></>}
          {selUnitLabel  && <><span>›</span><span>{selUnitLabel}</span></>}
          {selRoomLabel  && <><span>›</span><span style={{ color: 'var(--text-1)', fontWeight: 500 }}>{selRoomLabel}</span></>}
          {analysis && (
            <span className="badge badge-blue" style={{ marginLeft: 6 }}>
              {Math.round(analysis.overall_pct)}% complete
            </span>
          )}
        </div>
      </div>

      {loading ? <Spinner /> : !selRoom ? (
        <div className="card"><Empty message="No room selected" hint="Select Floor → Unit → Room above" /></div>
      ) : !analysis ? (
        <div className="card"><Empty message="No analysis yet for this room" hint="Upload a photo from the Upload tab to trigger Gemini AI" /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Latest analysis card */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 20 }}>
                <ProgressRing pct={Math.round(analysis.overall_pct)} size={80} strokeWidth={6} />
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4 }}>
                    Overall completion
                  </div>
                  <div style={{ fontSize: 28, fontFamily: 'Space Grotesk', fontWeight: 700, color: 'var(--text-1)', lineHeight: 1 }}>
                    {Math.round(analysis.overall_pct)}%
                  </div>
                  {analysis.delta_pct !== null && (
                    <div style={{ fontSize: 12, marginTop: 4, color: analysis.delta_pct > 0 ? '#4ADE80' : '#F87171' }}>
                      {analysis.delta_pct > 0 ? '↑' : '↓'} {Math.abs(analysis.delta_pct)}% vs last visit
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activityList.map(({ name, pct }) => (
                  <div key={name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'capitalize' }}>{name}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        {pct === null ? '—' : `${Math.round(pct)}%`}
                      </span>
                    </div>
                    <ProgressBar pct={pct || 0} height={4} />
                  </div>
                ))}
              </div>

              {analysis.ai_notes && (
                <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-hover)',
                  borderRadius: 8, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6,
                  borderLeft: '2px solid var(--amber-dim)' }}>
                  {analysis.ai_notes}
                </div>
              )}
            </div>

            {/* Radar card */}
            <div className="card">
              <SectionTitle>Component radar</SectionTitle>
              {radarData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="rgba(255,255,255,.06)" />
                    <PolarAngleAxis dataKey="s" tick={{ fontSize: 9, fill: 'var(--text-3)' }} />
                    <Radar dataKey="v" stroke="var(--amber)" fill="var(--amber)" fillOpacity={0.15} strokeWidth={2} />
                  </RadarChart>
                </ResponsiveContainer>
              ) : <Empty message="No component data" />}
            </div>
          </div>

          {/* Progress over time */}
          <div className="card">
            <SectionTitle>Progress over time</SectionTitle>
            {histChart.length > 1 ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={histChart}>
                  <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,.04)" />
                  <XAxis dataKey="visit" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CT />} />
                  <Line type="monotone" dataKey="pct" stroke="var(--amber)" strokeWidth={2.5}
                    dot={{ r: 4, fill: 'var(--amber)', strokeWidth: 0 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty message="Upload more photos over time to see trend" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
