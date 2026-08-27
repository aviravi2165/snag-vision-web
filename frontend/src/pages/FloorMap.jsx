import { useState, useRef, useEffect, useCallback } from 'react'
import { useProject } from '../hooks/useProject'
import { getFloors, getUnits, getRooms } from '../utils/api'
import toast from 'react-hot-toast'

const MARKER_R = 13

function statusColor(pct) {
  if (pct === undefined || pct === null) return '#6E7DEC'
  if (pct >= 80) return '#22B96B'
  if (pct >= 50) return '#E8A317'
  return '#E5484D'
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export default function FloorMap() {
  const { selectedProject } = useProject()

  const [imgSrc,  setImgSrc]  = useState(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const canvasRef = useRef(null)
  const imgRef    = useRef(null)
  const fileRef   = useRef(null)
  const wrapRef   = useRef(null)

  const [floors,   setFloors]   = useState([])
  const [selFloor, setSelFloor] = useState(null)
  const [units,    setUnits]    = useState([])
  const [selUnit,  setSelUnit]  = useState(null)
  const [rooms,    setRooms]    = useState([])

  const [hotspots,    setHotspots]    = useState([])
  const [selHotspot,  setSelHotspot]  = useState(null)
  const [pendingClick, setPendingClick] = useState(null)
  const [showPanel,   setShowPanel]   = useState(false)
  const [form, setForm] = useState({ room_id: '', label: '' })

  // ── Load hotspots from localStorage ──────────────────────────────────────
  useEffect(() => {
    if (!selectedProject) return
    const saved = localStorage.getItem(`siteiq_hotspots_${selectedProject.id}`)
    setHotspots(saved ? JSON.parse(saved) : [])
    setImgSrc(null)
    setPendingClick(null)
    setSelHotspot(null)
    setShowPanel(false)
  }, [selectedProject])

  const saveHotspots = useCallback((list) => {
    setHotspots(list)
    if (selectedProject)
      localStorage.setItem(`siteiq_hotspots_${selectedProject.id}`, JSON.stringify(list))
  }, [selectedProject])

  // ── Backend cascades ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedProject) return
    getFloors(selectedProject.id).then(({ data }) => {
      setFloors(data); setSelFloor(data[0]?.id || null)
    })
  }, [selectedProject])

  useEffect(() => {
    if (!selFloor) { setUnits([]); setSelUnit(null); return }
    getUnits(selFloor).then(({ data }) => { setUnits(data); setSelUnit(data[0]?.id || null) })
  }, [selFloor])

  useEffect(() => {
    if (!selUnit) { setRooms([]); return }
    getRooms(selUnit).then(({ data }) => setRooms(data))
  }, [selUnit])

  // ── Redraw canvas ─────────────────────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img || !imgSrc) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    hotspots.forEach(h => {
      const x = h.x_pct * canvas.width
      const y = h.y_pct * canvas.height
      const isSel = selHotspot?.id === h.id
      const color = statusColor(h.pct)

      ctx.shadowColor = color; ctx.shadowBlur = isSel ? 18 : 8
      ctx.beginPath()
      ctx.arc(x, y, isSel ? MARKER_R + 3 : MARKER_R, 0, Math.PI * 2)
      ctx.fillStyle = color + 'CC'; ctx.fill()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
      ctx.shadowBlur = 0

      ctx.fillStyle = '#fff'
      ctx.font = `bold ${isSel ? 11 : 10}px Inter, sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(h.label || '?', x, y)

      if (isSel) {
        const text = h.room_name || 'Room'
        ctx.font = '11px Inter, sans-serif'
        const tw = ctx.measureText(text).width + 16
        const th = 22, tx = x - tw / 2, ty = y - MARKER_R - th - 8
        ctx.fillStyle = 'rgba(13,15,20,0.92)'; ctx.strokeStyle = color; ctx.lineWidth = 1.5
        roundRect(ctx, tx, ty, tw, th, 6); ctx.fill(); ctx.stroke()
        ctx.fillStyle = '#F4F6FC'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(text, x, ty + th / 2)
      }
    })

    if (pendingClick) {
      const x = pendingClick.x_pct * canvas.width
      const y = pendingClick.y_pct * canvas.height
      ctx.shadowColor = '#6E7DEC'; ctx.shadowBlur = 14
      ctx.beginPath(); ctx.arc(x, y, MARKER_R, 0, Math.PI * 2)
      ctx.fillStyle = '#6E7DEC88'; ctx.fill()
      ctx.strokeStyle = '#6E7DEC'; ctx.lineWidth = 2; ctx.stroke()
      ctx.shadowBlur = 0
      ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Inter, sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('+', x, y)
    }
  }, [hotspots, pendingClick, selHotspot, imgSrc])

  useEffect(() => { redraw() }, [redraw])

  // ── Image upload ──────────────────────────────────────────────────────────
  const handleImageUpload = (e) => {
    const file = e.target.files[0]; if (!file) return
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      imgRef.current = image
      const maxW = (wrapRef.current?.clientWidth || 900) - 4
      const scale = Math.min(1, maxW / image.width)
      const w = Math.round(image.width * scale)
      const h = Math.round(image.height * scale)
      setImgSize({ w, h })
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      setImgSrc(url)
    }
    image.src = url
  }

  // ── Canvas click ──────────────────────────────────────────────────────────
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width  / rect.width
    const scaleY = canvas.height / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top)  * scaleY
    const x_pct = x / canvas.width
    const y_pct = y / canvas.height

    const hit = hotspots.find(h => {
      const hx = h.x_pct * canvas.width
      const hy = h.y_pct * canvas.height
      return Math.hypot(hx - x, hy - y) <= MARKER_R + 6
    })

    if (hit) {
      setSelHotspot(hit)
      setForm({ room_id: hit.room_id || '', label: hit.label || '' })
      setPendingClick(null)
      setShowPanel(true)
    } else {
      setPendingClick({ x_pct, y_pct })
      setSelHotspot(null)
      setForm({ room_id: rooms[0]?.id || '', label: '' })
      setShowPanel(true)
    }
  }

  // ── Save / delete ─────────────────────────────────────────────────────────
  const handleSave = () => {
    if (!form.room_id) { toast.error('Select a room first'); return }
    const room = rooms.find(r => r.id === form.room_id)
    const label = form.label || room?.name?.slice(0, 3).toUpperCase() || '?'

    if (selHotspot) {
      saveHotspots(hotspots.map(h =>
        h.id === selHotspot.id
          ? { ...h, room_id: form.room_id, room_name: room?.name, label, pct: room?.progress_pct ?? null }
          : h
      ))
      toast.success('Hotspot updated')
    } else if (pendingClick) {
      saveHotspots([...hotspots, {
        id: Date.now().toString(),
        ...pendingClick,
        room_id: form.room_id, room_name: room?.name,
        label, pct: room?.progress_pct ?? null,
      }])
      toast.success('Hotspot pinned')
    }
    setPendingClick(null); setSelHotspot(null); setShowPanel(false)
  }

  const handleDelete = () => {
    if (!selHotspot) return
    saveHotspots(hotspots.filter(h => h.id !== selHotspot.id))
    setSelHotspot(null); setShowPanel(false)
    toast.success('Hotspot removed')
  }

  const handleCancel = () => { setPendingClick(null); setSelHotspot(null); setShowPanel(false) }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 28, maxWidth: 1200 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 4 }}>
          Floor plan mapper
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
          Upload a floor plan image → click any room → link it to your project hierarchy.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: showPanel ? '1fr 280px' : '1fr', gap: 16, alignItems: 'start' }}>
        {/* ── Canvas card ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Toolbar */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-dim)',
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ fontSize: 12, padding: '7px 14px' }}
              onClick={() => fileRef.current?.click()}>
              📁 Upload floor plan
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }} onChange={handleImageUpload} />

            <select style={{ width: 'auto', fontSize: 12 }} value={selFloor || ''}
              onChange={e => setSelFloor(e.target.value)} disabled={!floors.length}>
              {!floors.length ? <option>No floors</option>
                : floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
            </select>

            <select style={{ width: 'auto', fontSize: 12 }} value={selUnit || ''}
              onChange={e => setSelUnit(e.target.value)} disabled={!units.length}>
              {!units.length ? <option>No units</option>
                : units.map(u => <option key={u.id} value={u.id}>Unit {u.unit_number}</option>)}
            </select>

            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
              {hotspots.length} hotspot{hotspots.length !== 1 ? 's' : ''} pinned
            </span>

            {hotspots.length > 0 && (
              <button className="btn-ghost" onClick={() => { if (window.confirm('Clear all hotspots?')) saveHotspots([]) }}
                style={{ fontSize: 11, padding: '5px 10px', color: '#EE6A6A', borderColor: '#EE6A6A44' }}>
                Clear all
              </button>
            )}
          </div>

          {/* Canvas / empty state */}
          <div ref={wrapRef} style={{ position: 'relative', minHeight: 420, display: 'flex',
            alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
            {!imgSrc ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
                color: 'var(--text-3)', padding: 48, textAlign: 'center' }}>
                <div style={{ fontSize: 52 }}>🗺️</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)' }}>No floor plan uploaded</div>
                <div style={{ fontSize: 12 }}>Upload a PNG/JPG of your floor plan to start pinning rooms</div>
                <button className="btn-primary" style={{ marginTop: 8 }}
                  onClick={() => fileRef.current?.click()}>Upload PNG / JPG</button>
              </div>
            ) : (
              <canvas ref={canvasRef} width={imgSize.w} height={imgSize.h}
                onClick={handleCanvasClick}
                style={{ display: 'block', cursor: 'crosshair', maxWidth: '100%' }} />
            )}
          </div>

          {/* Legend */}
          {imgSrc && (
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-dim)',
              display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Click image to pin · Click marker to edit</span>
              {[['#22B96B','≥80%'],['#E8A317','50–79%'],['#E5484D','<50%'],['#6E7DEC','Not analysed']].map(([c,t]) => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />{t}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Side panel ── */}
        {showPanel && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14 }}>
                {selHotspot ? 'Edit hotspot' : 'New hotspot'}
              </span>
              <button onClick={handleCancel} style={{ background: 'none', border: 'none',
                color: 'var(--text-3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>

            {pendingClick && (
              <div style={{ background: 'var(--amber-glow)', border: '1px solid var(--amber-dim)',
                borderRadius: 8, padding: '8px 10px', fontSize: 11, color: 'var(--amber)' }}>
                📍 Clicked at ({(pendingClick.x_pct * 100).toFixed(1)}%,&nbsp;
                {(pendingClick.y_pct * 100).toFixed(1)}%)
              </div>
            )}

            <div>
              <label className="label">Room</label>
              <select value={form.room_id} onChange={e => setForm({ ...form, room_id: e.target.value })}>
                {!rooms.length
                  ? <option value="">No rooms — select unit above</option>
                  : rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)
                }
              </select>
            </div>

            <div>
              <label className="label">
                Marker label&nbsp;
                <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: 10, color: 'var(--text-3)' }}>
                  (3 chars, e.g. BR1)
                </span>
              </label>
              <input maxLength={3} placeholder="Auto from room name"
                value={form.label}
                onChange={e => setForm({ ...form, label: e.target.value.toUpperCase() })} />
            </div>

            {/* Room preview */}
            {(() => {
              const r = rooms.find(x => x.id === form.room_id)
              if (!r) return null
              return (
                <div style={{ background: 'var(--bg-hover)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>Room preview</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>{r.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${r.progress_pct || 0}%`,
                        background: statusColor(r.progress_pct), borderRadius: 2 }} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{Math.round(r.progress_pct || 0)}%</span>
                  </div>
                </div>
              )
            })()}

            <button className="btn-primary" onClick={handleSave} style={{ width: '100%' }}>
              {selHotspot ? 'Update hotspot' : 'Pin hotspot'}
            </button>
            {selHotspot && (
              <button className="btn-ghost" onClick={handleDelete}
                style={{ width: '100%', color: '#EE6A6A', borderColor: '#EE6A6A44' }}>
                Delete hotspot
              </button>
            )}
            <button className="btn-ghost" onClick={handleCancel} style={{ width: '100%' }}>Cancel</button>
          </div>
        )}
      </div>

      {/* Hotspot table */}
      {hotspots.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 12 }}>
            Pinned hotspots — {selectedProject?.name}
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Marker</th><th>Room</th><th>Position (x%, y%)</th><th>Progress</th><th></th></tr>
            </thead>
            <tbody>
              {hotspots.map(h => (
                <tr key={h.id} style={{ cursor: 'pointer' }} onClick={() => {
                  setSelHotspot(h); setForm({ room_id: h.room_id, label: h.label })
                  setPendingClick(null); setShowPanel(true)
                }}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 28, height: 28, borderRadius: '50%',
                      background: statusColor(h.pct) + '22',
                      border: `1px solid ${statusColor(h.pct)}66`,
                      fontSize: 10, fontWeight: 700, color: statusColor(h.pct) }}>
                      {h.label}
                    </span>
                  </td>
                  <td style={{ fontWeight: 500 }}>{h.room_name || '—'}</td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>
                    {(h.x_pct * 100).toFixed(1)}%, {(h.y_pct * 100).toFixed(1)}%
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 60, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${h.pct || 0}%`,
                          background: statusColor(h.pct), borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 12 }}>{h.pct !== null ? `${Math.round(h.pct || 0)}%` : '—'}</span>
                    </div>
                  </td>
                  <td><button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
