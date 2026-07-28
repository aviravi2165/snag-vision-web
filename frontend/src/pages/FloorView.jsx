import { useEffect, useState } from 'react'
import { getFloors, getUnits, getRooms, getRoomAnalysis } from '../utils/api'
// ✅ FIX 1: useProject import — local project state completely hataya
import { useProject } from '../hooks/useProject'
import { Spinner, ProgressBar, StatusBadge, ProgressRing, SectionTitle, Empty } from '../components/UI'
import FloorViewNew from './FloorViewNew'

const NEW_FLOORVIEW_KEY = 'vestigia_new_floorview_enabled'

function heatStyle(pct) {
  if (pct >= 95) return { bg: 'rgba(34,197,94,.12)', border: 'rgba(34,197,94,.25)', text: '#4ADE80' }
  if (pct >= 80) return { bg: 'rgba(34,197,94,.07)', border: 'rgba(34,197,94,.15)', text: '#86EFAC' }
  if (pct >= 60) return { bg: 'rgba(245,166,35,.1)', border: 'rgba(245,166,35,.2)', text: '#FCD34D' }
  if (pct >= 40) return { bg: 'rgba(249,115,22,.1)', border: 'rgba(249,115,22,.2)', text: '#FB923C' }
  return { bg: 'rgba(239,68,68,.1)', border: 'rgba(239,68,68,.2)', text: '#F87171' }
}

function FloorViewClassic() {
  // ✅ FIX 2: Global context se selectedProject lo
  // BUG: Pehle local state thi jo hamesha first project (Taj) set karti thi
  // aur global context ka change kabhi reach nahi karta tha
  const { selectedProject } = useProject()

  const [floors,   setFloors]   = useState([])
  const [units,    setUnits]    = useState([])
  const [rooms,    setRooms]    = useState([])
  const [roomData, setRoomData] = useState({})
  const [selectedFloor, setSelectedFloor] = useState(null)
  const [selectedUnit,  setSelectedUnit]  = useState(null)
  const [selectedRoom,  setSelectedRoom]  = useState(null)
  const [loading, setLoading] = useState(false)

  // ✅ FIX 3: Global selectedProject change pe complete reset + fresh load
  useEffect(() => {
    if (!selectedProject) return

    // Stale data clear karo — warna purani project rooms dikhengi
    setFloors([])
    setUnits([])
    setRooms([])
    setRoomData({})
    setSelectedFloor(null)
    setSelectedUnit(null)
    setSelectedRoom(null)

    setLoading(true)
    getFloors(selectedProject.id)
      .then(({ data }) => {
        setFloors(data)
        setSelectedFloor(data[0]?.id || null)
      })
      .finally(() => setLoading(false))
  }, [selectedProject]) // ✅ FIX 4: selectedProject object pe depend — sidebar switch instantly react karega

  // Cascade: floor → units
  useEffect(() => {
    if (!selectedFloor) { setUnits([]); setSelectedUnit(null); return }
    getUnits(selectedFloor).then(({ data }) => {
      setUnits(data)
      setSelectedUnit(data[0]?.id || null)
    })
  }, [selectedFloor])

  // Cascade: unit → rooms + analyses
  useEffect(() => {
    if (!selectedUnit) { setRooms([]); setSelectedRoom(null); setRoomData({}); return }
    getRooms(selectedUnit).then(({ data }) => {
      setRooms(data)
      setSelectedRoom(data[0]?.id || null)
      setRoomData({}) // ✅ FIX 5: Unit change par purana roomData clear
      data.forEach(r => {
        getRoomAnalysis(r.id)
          .then(({ data: a }) => setRoomData(p => ({ ...p, [r.id]: a })))
          .catch(() => {})
      })
    })
  }, [selectedUnit])

  const activeRoom     = rooms.find(r => r.id === selectedRoom)
  const activeAnalysis = selectedRoom ? roomData[selectedRoom] : null

  return (
    <div style={{ padding: '28px', maxWidth: 1100 }}>
      {/* ✅ FIX 6: Header se Project dropdown hatayi — sidebar se global control hoti hai */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700 }}>Floor view</h1>

        {/* Active project badge — clearly dikhata hai kaunsa project active hai */}
        {selectedProject && (
          <span style={{
            fontSize: 12, fontWeight: 600, color: 'var(--amber)',
            background: 'var(--amber-glow)', border: '1px solid var(--amber-dim)',
            borderRadius: 20, padding: '4px 12px',
          }}>
            {selectedProject.name}
          </span>
        )}

        <select
          style={{ width: 'auto' }}
          value={selectedFloor || ''}
          onChange={e => setSelectedFloor(e.target.value)}
          disabled={!floors.length}
        >
          {floors.length === 0
            ? <option value="">No floors</option>
            : floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)
          }
        </select>

        <select
          style={{ width: 'auto' }}
          value={selectedUnit || ''}
          onChange={e => setSelectedUnit(e.target.value)}
          disabled={!units.length}
        >
          {units.length === 0
            ? <option value="">No units</option>
            : units.map(u => <option key={u.id} value={u.id}>Unit {u.unit_number}</option>)
          }
        </select>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
          {/* Heatmap */}
          <div className="card">
            <SectionTitle>Room heatmap</SectionTitle>
            {rooms.length === 0
              ? <Empty message="No rooms in this unit" hint="Add rooms via Projects setup" />
              : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }}>
                    {rooms.map(r => {
                      const pct = Math.round(r.progress_pct || 0)
                      const s = heatStyle(pct)
                      const isActive = selectedRoom === r.id
                      return (
                        <div
                          key={r.id}
                          onClick={() => setSelectedRoom(r.id)}
                          style={{
                            background: s.bg,
                            border: `1px solid ${isActive ? 'var(--amber)' : s.border}`,
                            borderRadius: 10, padding: '14px 12px', textAlign: 'center',
                            cursor: 'pointer', transition: 'all .15s',
                            boxShadow: isActive ? '0 0 0 1px var(--amber)' : 'none',
                          }}
                        >
                          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>{r.name}</div>
                          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Space Grotesk', color: s.text }}>{pct}%</div>
                          <div style={{ marginTop: 8 }}>
                            <StatusBadge pct={pct} flag={roomData[r.id]?.change_flag} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {/* Legend */}
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {[
                      ['#4ADE80', '≥95% Complete'],
                      ['#FCD34D', '50–94% In progress'],
                      ['#F87171', '<50% Delayed'],
                    ].map(([c, t]) => (
                      <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
                        <div style={{ width: 10, height: 10, borderRadius: 3, background: c + '33', border: `1px solid ${c}66` }} />
                        {t}
                      </div>
                    ))}
                  </div>
                </>
              )
            }
          </div>

          {/* Room detail panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {activeRoom ? (
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>Selected room</div>
                    <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 15 }}>{activeRoom.name}</div>
                  </div>
                  <ProgressRing pct={Math.round(activeRoom.progress_pct || 0)} size={60} strokeWidth={5} />
                </div>

                {activeAnalysis?.components && Object.entries(activeAnalysis.components).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {Object.entries(activeAnalysis.components).map(([k, v]) => (
                      <div key={k}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-2)', textTransform: 'capitalize' }}>
                            {k.replace(/_/g, ' ')}
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-1)' }}>
                            {Math.round(v)}%
                          </span>
                        </div>
                        <ProgressBar pct={v} height={3} />
                      </div>
                    ))}
                    {activeAnalysis.ai_notes && (
                      <div style={{
                        marginTop: 6, padding: '8px 10px',
                        background: 'var(--bg-hover)', borderRadius: 8,
                        fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6,
                        borderLeft: '2px solid var(--amber-dim)',
                      }}>
                        {activeAnalysis.ai_notes}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '12px 0' }}>
                    No analysis yet — upload a photo
                  </div>
                )}
              </div>
            ) : (
              <div className="card">
                <Empty message="No room selected" hint="Click a room in the heatmap" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Feature toggle: lets you try the new Floor View layout and switch back to
// the classic one instantly — nothing about FloorViewClassic above is touched. ──
export default function FloorView() {
  const [isNewFloorViewEnabled, setIsNewFloorViewEnabled] = useState(
    () => localStorage.getItem(NEW_FLOORVIEW_KEY) === 'true'
  )

  const toggle = () => {
    setIsNewFloorViewEnabled(v => {
      const next = !v
      localStorage.setItem(NEW_FLOORVIEW_KEY, String(next))
      return next
    })
  }

  return (
    <div>
      {/* Thin toggle bar — sits above whichever layout is active, doesn't affect its padding */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: 8, padding: '10px 28px 0' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {isNewFloorViewEnabled ? 'New Floor View layout' : 'Try new Floor View layout'}
        </span>
        <div
          role="switch"
          aria-checked={isNewFloorViewEnabled}
          onClick={toggle}
          title="Toggle between classic and new Floor View layout"
          style={{
            width: 38, height: 21, borderRadius: 11, cursor: 'pointer',
            background: isNewFloorViewEnabled ? 'var(--amber)' : 'var(--border, #D5D5D5)',
            position: 'relative', transition: 'background .2s', flexShrink: 0,
          }}
        >
          <div style={{
            position: 'absolute', top: 2, left: isNewFloorViewEnabled ? 19 : 2,
            width: 17, height: 17, borderRadius: '50%', background: '#fff',
            transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }} />
        </div>
      </div>

      {isNewFloorViewEnabled ? (
        <div style={{ padding: '18px 28px 28px' }}>
          <FloorViewNew />
        </div>
      ) : (
        <FloorViewClassic />
      )}
    </div>
  )
}
