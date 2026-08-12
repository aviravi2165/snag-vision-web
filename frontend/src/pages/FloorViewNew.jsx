/**
 * FloorViewNew.jsx — "Internal Floorwise Summary" layout
 *
 * Left: project/tower summary card + category list (with progress bars).
 * Grid: one tile per Room ID (Unit) on the selected floor, color-banded by
 * completion % with a Δ delta, plus a Date picker that time-travels the whole
 * view using each room's real analysis history (getChangeDetection).
 * Selecting a flat reveals its floor plan + room-by-room breakdown; selecting
 * a room reveals its latest captured photo + a per-category deep dive.
 *
 * Everything shown is computed from real backend data — status labels and
 * "pending" lists are derived from actual numeric component values, not
 * AI-generated text, since the current Gemini prompt only returns numbers
 * per component plus one whole-room note (no per-category description).
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { useProject } from '../hooks/useProject'
import {
  getFloors, getUnits, getRooms, getRoomAnalysis, getChangeDetection,
  getRoomUploads,
} from '../utils/api'
import { Spinner, Empty } from '../components/UI'
import { Panorama360 } from './PanoramaViewer'
import { STANDARD_ACTIVITIES } from '../utils/standardActivities'

// ─── Completion bands (mirrors the 5-state legend) ─────────────────────────
const BANDS = [
  { max: 0.01, label: 'Not started',        bg: '#F1F5FB', border: '#CBD7E6', text: '#64748B' },
  { max: 25,   label: 'Bare shell',         bg: '#EAF2FF', border: '#BFD5FF', text: '#2F6FED' },
  { max: 60,   label: 'Services & build-up', bg: '#EAF7F8', border: '#BCE4E8', text: '#2D879B' },
  { max: 90,   label: 'Finishing works',    bg: '#F2EDFF', border: '#D7C8FF', text: '#7655C8' },
  { max: 101,  label: 'Near completion',    bg: '#EAF7F2', border: '#BCE7DC', text: '#16856F' },
]
function bandFor(pct) {
  if (pct === null || pct === undefined) return BANDS[0]
  return BANDS.find(b => pct <= b.max) || BANDS[BANDS.length - 1]
}

// ─── KPI grid coloring (Floor tile + Room ID tiles): 3 simple bands ─────────
const KPI_BANDS = [
  { max: 40,  label: '< 40%',   bg: '#EAF2FF', border: '#BFD5FF', text: '#2F6FED' },
  { max: 75,  label: '40–75%',  bg: '#F2EDFF', border: '#D7C8FF', text: '#7655C8' },
  { max: 101, label: '> 75%',   bg: '#EAF7F2', border: '#BCE7DC', text: '#16856F' },
]
function kpiColor(pct) {
  if (pct === null || pct === undefined) return KPI_BANDS[0]
  return KPI_BANDS.find(b => pct < b.max) || KPI_BANDS[KPI_BANDS.length - 1]
}
// Vivid bar-fill color (the band's muted `text` color reads as mustard on a progress bar)
function barColor(pct) {
  if (pct === null || pct === undefined) return '#94A3B8'
  if (pct < 40) return '#2F6FED'
  if (pct < 75) return '#7655C8'
  return '#16856F'
}

// Pick the history entry that was current as of `dateKey` (or the latest if dateKey is null)
function historyAt(history, dateKey) {
  if (!history.length) return null
  if (!dateKey) return history[history.length - 1]
  let picked = null
  for (const h of history) {
    if (h.date.slice(0, 10) <= dateKey) picked = h
  }
  return picked
}

export default function FloorViewNew() {
  const { selectedProject } = useProject()

  const [floors,        setFloors]        = useState([])
  const [selectedFloor, setSelectedFloor] = useState(null)
  const [loadingFloor,  setLoadingFloor]  = useState(false)

  // { [unitId]: { unit, rooms: [{ room, history, latestNotes }] } }
  const [unitData,   setUnitData]   = useState({})

  const [selectedCategory, setSelectedCategory] = useState('Overall')
  const [selectedDate,     setSelectedDate]     = useState(null)   // null = latest
  const [selectedUnitId,   setSelectedUnitId]   = useState(null)
  const [focusedRoomId,    setFocusedRoomId]    = useState(null)
  const [focusedUploads,   setFocusedUploads]   = useState([])

  // ── Load floors for the active project ──────────────────────────────────
  useEffect(() => {
    setFloors([]); setSelectedFloor(null); setUnitData({}); setSelectedUnitId(null)
    if (!selectedProject) return
    getFloors(selectedProject.id).then(({ data }) => {
      setFloors(data)
      setSelectedFloor(data[0]?.id || null)
    })
  }, [selectedProject])

  // ── Load every unit + room + full analysis history for the selected floor ──
  useEffect(() => {
    let cancelled = false
    async function load() {
      setUnitData({}); setSelectedUnitId(null); setSelectedCategory('Overall'); setSelectedDate(null)
      if (!selectedProject || !selectedFloor) return
      setLoadingFloor(true)
      try {
        const { data: units } = await getUnits(selectedFloor)
        const next = {}
        for (const unit of units) {
          const { data: rooms } = await getRooms(unit.id)
          const roomsWithHistory = await Promise.all(rooms.map(async room => {
            const history = await getChangeDetection(room.id).then(r => r.data).catch(() => [])
            const latest = await getRoomAnalysis(room.id).then(r => r.data).catch(() => null)
            return { room, history, latestNotes: latest?.ai_notes || null }
          }))
          next[unit.id] = { unit, rooms: roomsWithHistory }
        }
        if (!cancelled) {
          setUnitData(next)
          setSelectedUnitId(units[0]?.id || null)
        }
      } finally {
        if (!cancelled) setLoadingFloor(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [selectedProject, selectedFloor, floors])

  const units = useMemo(() => Object.values(unitData), [unitData])

  // ── Dates available anywhere on this floor (drives the Date picker) ─────
  const availableDates = useMemo(() => {
    const set = new Set()
    units.forEach(({ rooms }) => rooms.forEach(({ history }) =>
      history.forEach(h => set.add(h.date.slice(0, 10)))
    ))
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [units])

  // ── Categories: "Overall" + the standard 12-category catalog (the fixed
  // list Floor View / AI Analysis render — see utils/standardActivities.js).
  // NOT the project's Activity-Excel plan, which stays the Executive
  // dashboard's BoQ view. ────────────────────────────────────────────────────
  const categories = useMemo(
    () => ['Overall', ...STANDARD_ACTIVITIES],
    []
  )

  const roomValueFor = useCallback((room, history, category) => {
    const at = historyAt(history, selectedDate)
    if (!at) return { pct: room.progress_pct ?? null, delta: null, flag: null }
    if (category === 'Overall') return { pct: at.overall_pct, delta: at.delta, flag: at.flag }
    const entry = (at.mapped || []).find(m => m.name === category)
    return { pct: entry ? entry.pct : null, delta: null, flag: null }
  }, [selectedDate])

  const categoryFloorAvg = useCallback((category) => {
    const values = []
    units.forEach(({ rooms }) => rooms.forEach(({ room, history }) => {
      const { pct } = roomValueFor(room, history, category)
      if (typeof pct === 'number') values.push(pct)
    }))
    if (!values.length) return null
    return values.reduce((a, b) => a + b, 0) / values.length
  }, [units, roomValueFor])

  const unitValue = useCallback((entry, category) => {
    const values = entry.rooms
      .map(({ room, history }) => roomValueFor(room, history, category).pct)
      .filter(v => typeof v === 'number')
    if (!values.length) return null
    return values.reduce((a, b) => a + b, 0) / values.length
  }, [roomValueFor])

  const unitDelta = useCallback((entry) => {
    const deltas = entry.rooms
      .map(({ room, history }) => roomValueFor(room, history, 'Overall').delta)
      .filter(v => typeof v === 'number')
    if (!deltas.length) return null
    return deltas.reduce((a, b) => a + b, 0) / deltas.length
  }, [roomValueFor])

  const floorAvg   = categoryFloorAvg(selectedCategory)
  const floorAlert = units.some(({ rooms }) =>
    rooms.some(({ room, history }) => roomValueFor(room, history, 'Overall').flag === 'rework'))

  const selectedEntry = selectedUnitId ? unitData[selectedUnitId] : null

  // Progress highlights: rooms with the largest positive delta at the selected date
  const highlights = useMemo(() => {
    if (!selectedEntry) return []
    return selectedEntry.rooms
      .map(({ room, history }) => ({ room, ...roomValueFor(room, history, 'Overall') }))
      .filter(r => typeof r.delta === 'number' && r.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3)
  }, [selectedEntry, roomValueFor])

  // Pending categories for a room at the selected date — mapped activity
  // breakdown entries that haven't hit 100% yet
  const pendingComponents = useCallback((room, history) => {
    const at = historyAt(history, selectedDate)
    return (at?.mapped || [])
      .filter(m => m.pct < 100)
      .map(m => m.name)
  }, [selectedDate])

  // ── Media viewer: uploads for the focused room, closest to the selected date ──
  useEffect(() => {
    if (!focusedRoomId) { setFocusedUploads([]); return }
    getRoomUploads(focusedRoomId).then(({ data }) => setFocusedUploads(data)).catch(() => setFocusedUploads([]))
  }, [focusedRoomId])

  useEffect(() => {
    setFocusedRoomId(selectedEntry?.rooms[0]?.room.id || null)
  }, [selectedEntry])

  const focusedUpload = useMemo(() => {
    if (!focusedUploads.length) return null
    if (!selectedDate) return focusedUploads[0] // list is already newest-first
    const eligible = focusedUploads.filter(u => u.uploaded_at.slice(0, 10) <= selectedDate)
    return eligible[0] || null
  }, [focusedUploads, selectedDate])

  const focusedEntry = selectedEntry?.rooms.find(r => r.room.id === focusedRoomId) || null
  const focusedValue = focusedEntry ? roomValueFor(focusedEntry.room, focusedEntry.history, 'Overall') : null

  if (!selectedProject) {
    return <div className="card"><Empty message="No active project" hint="Select a project from the sidebar" /></div>
  }

  const selectedFloorObj = floors.find(f => f.id === selectedFloor)
  const capturedRooms = units.reduce((n, { rooms }) => n + rooms.filter(({ history }) => history.length > 0).length, 0)
  const totalRooms     = units.reduce((n, { rooms }) => n + rooms.length, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Snag-List + Date ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => toast('Coming soon')}>
          Snag-List
        </button>
        <select value={selectedDate || ''} onChange={e => setSelectedDate(e.target.value || null)}
          style={{ width: 'auto', fontSize: 12 }}>
          <option value="">Latest</option>
          {availableDates.map(d => (
            <option key={d} value={d}>{new Date(d + 'T00:00:00').toLocaleDateString()}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
        {/* ── Left: tower/project summary + categories ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card">
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15, color: 'var(--text-1)' }}>
              VESTIGIA AI Progress
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <div style={{ flex: 1, background: '#EAF2FF', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)' }}>OVERALL PROGRESS</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-1)' }}>
                  {floorAvg === null ? '—' : `${Math.round(floorAvg)}%`}
                </div>
              </div>
              <div style={{ flex: 1, background: '#EAF2FF', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)' }}>ROOMS CAPTURED</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-1)' }}>{capturedRooms}/{totalRooms}</div>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {categories.map(cat => {
              const avg = categoryFloorAvg(cat)
              const isActive = selectedCategory === cat
              return (
                <button key={cat} onClick={() => setSelectedCategory(cat)} style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  background: isActive ? 'var(--amber-glow)' : 'transparent',
                  border: `1px solid ${isActive ? 'var(--amber-dim)' : 'transparent'}`,
                  borderRadius: 8, padding: '8px 10px', cursor: 'pointer', textAlign: 'left',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12.5, color: isActive ? 'var(--amber)' : 'var(--text-2)' }}>
                      {cat}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
                      {avg === null ? '—' : `${Math.round(avg)}%`}
                    </span>
                  </div>
                  <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${avg || 0}%`, background: 'var(--amber)', borderRadius: 2 }} />
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Right: floor selector + grid + detail ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <select value={selectedFloor || ''} onChange={e => setSelectedFloor(e.target.value)}
              style={{ width: 'auto' }} disabled={!floors.length}>
              {!floors.length && <option value="">No floors</option>}
              {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {selectedCategory === 'Overall' ? 'Overall completion' : selectedCategory} per Room ID
            </span>
          </div>

          {/* Grid matrix */}
          <div className="card">
            {loadingFloor ? <Spinner /> : units.length === 0 ? (
              <Empty message="No Room IDs on this floor" hint="Add them in Create Project" />
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 10, marginBottom: 14 }}>
                  {/* Floor summary tile */}
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    padding: '12px 8px', borderRadius: 10, position: 'relative',
                    background: '#EAF2FF', border: '1.5px solid #BFD5FF',
                  }}>
                    {floorAlert && (
                      <span style={{ position: 'absolute', top: 6, right: 8, width: 7, height: 7,
                        borderRadius: '50%', background: '#D96A32' }} />
                    )}
                    <span style={{ fontSize: 11, color: '#111111' }}>Floor {selectedFloorObj?.floor_number}</span>
                    <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'Space Grotesk', color: '#111111' }}>
                      {floorAvg === null ? '—' : `${Math.round(floorAvg)}%`}
                    </span>
                  </div>

                  {units.map(entry => {
                    const val   = unitValue(entry, selectedCategory)
                    const delta = selectedCategory === 'Overall' ? unitDelta(entry) : null
                    const band  = kpiColor(val)
                    const isActive = selectedUnitId === entry.unit.id
                    return (
                      <button key={entry.unit.id} onClick={() => setSelectedUnitId(entry.unit.id)} style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                        padding: '12px 8px', borderRadius: 10, cursor: 'pointer',
                        background: '#EAF2FF', border: `1.5px solid ${isActive ? 'var(--accent)' : '#BFD5FF'}`,
                        boxShadow: isActive ? '0 0 0 1px var(--amber)' : 'none',
                      }}>
                        <span style={{ fontSize: 11, color: '#111111' }}>{entry.unit.unit_number}</span>
                        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'Space Grotesk', color: '#111111' }}>
                          {val === null ? '—' : `${Math.round(val)}%`}
                        </span>
                        {delta !== null && (
                          <span style={{ fontSize: 10, color: '#111111' }}>
                            {delta >= 0 ? '▲' : '▼'}{Math.abs(delta).toFixed(0)}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* Legend */}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', borderTop: '1px solid var(--border-dim)', paddingTop: 10 }}>
                  {KPI_BANDS.map(b => (
                    <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: b.bg, border: `1px solid ${b.border}` }} />
                      {b.label}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Flat summary + floor plan */}
          {selectedEntry && (() => {
            const flatVal = unitValue(selectedEntry, 'Overall')
            const flatDelta = unitDelta(selectedEntry)
            return (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ background: '#13264B', color: '#fff', padding: '10px 14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    📍 Flat Summary — {selectedEntry.unit.unit_number}
                  </span>
                  <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#B9C7DA' }}>PROGRESS</span>
                    <strong>{flatVal === null ? '—' : `${Math.round(flatVal)}%`}</strong>
                    {flatDelta !== null && (
                      <span style={{ color: flatDelta >= 0 ? '#65C9B4' : '#F29A70' }}>
                        {flatDelta >= 0 ? '▲' : '▼'} {Math.abs(flatDelta).toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>

                <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)' }}>
                    Room-by-room progress
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                    {selectedEntry.rooms.map(({ room, history, latestNotes }) => {
                      const { pct } = roomValueFor(room, history, 'Overall')
                      const pending = pendingComponents(room, history)
                      const isFocused = focusedRoomId === room.id
                      return (
                        <div key={room.id} onClick={() => setFocusedRoomId(room.id)} style={{
                          border: `1px solid ${isFocused ? 'var(--amber)' : 'var(--border-dim)'}`,
                          borderRadius: 10, padding: 10, cursor: 'pointer',
                          background: isFocused ? 'var(--amber-glow)' : 'transparent',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <strong style={{ fontSize: 13 }}>{room.name}</strong>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
                              {pct === null ? '—' : `${Math.round(pct)}%`}
                            </span>
                          </div>
                          <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
                            <div style={{ height: '100%', width: `${pct || 0}%`, background: barColor(pct), borderRadius: 2 }} />
                          </div>
                          {!selectedDate && latestNotes && (
                            <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>
                              <span>✅</span><span>{latestNotes}</span>
                            </div>
                          )}
                          {pending.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
                              <span>⚠️</span><span>Pending: {pending.join(', ')}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em',
                      color: 'var(--text-3)', marginBottom: 6 }}>Progress highlights</div>
                    {highlights.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No recent improvements</div>
                    ) : highlights.map(h => (
                      <div key={h.room.id} style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        ▲ {h.room.name} — +{h.delta.toFixed(1)}% since last visit
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Point summary: focused room's photo + category deep dive */}
          {focusedEntry && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {focusedUpload ? (
                  <Panorama360 src={focusedUpload.gcs_url} height={300} />
                ) : (
                  <div style={{ padding: 32 }}><Empty message="No photo captured for this room yet" /></div>
                )}
              </div>

              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ background: '#13264B', color: '#fff', padding: '10px 14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    📍 Point Summary — {selectedEntry.unit.unit_number}_{focusedEntry.room.name}
                  </span>
                  <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#B9C7DA' }}>PROGRESS</span>
                    <strong>{focusedValue?.pct === null || focusedValue?.pct === undefined ? '—' : `${Math.round(focusedValue.pct)}%`}</strong>
                    {typeof focusedValue?.delta === 'number' && (
                      <span style={{ color: focusedValue.delta >= 0 ? '#65C9B4' : '#F29A70' }}>
                        {focusedValue.delta >= 0 ? '▲' : '▼'} {Math.abs(focusedValue.delta).toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 4 }}>Stage of work</div>
                    <div style={{ fontSize: 13, color: 'var(--text-1)' }}>{bandFor(focusedValue?.pct).label}</div>
                  </div>
                  {!selectedDate && focusedEntry.latestNotes && (
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 4 }}>Observation</div>
                      <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{focusedEntry.latestNotes}</div>
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 4 }}>Pending tasks</div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                      [ {pendingComponents(focusedEntry.room, focusedEntry.history).map(t => `"${t}"`).join(', ') || '—'} ]
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
