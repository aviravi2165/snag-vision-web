/**
 * SiteSetup.jsx  —  Layout Setup Module (v4)
 *
 * Floor → Room ID → Area hierarchy is always read live from the backend
 * (Create Project is the single source of truth) — floors via getFloors,
 * Room IDs (Units) via getUnits, Areas (Rooms) via getRooms. Nothing here
 * is duplicated or hand-typed, so changes made in Create Project show up
 * the next time a floor is picked or the hotspot modal is opened.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSite } from '../hooks/SiteContext'
import { getUnits, getRooms } from '../utils/api'
import toast from 'react-hot-toast'

// ─── Hotspot visual constants ──────────────────────────────────────────────────
const DOT_D       = 8      // visible dot diameter in CSS px (rendered at fixed size, then
                            // scaled via CSS transform — not shrunk to sub-pixel widths — so
                            // it stays crisp instead of blurry when the floor plan is zoomed in)
const HIT_PAD     = 12     // click hit area padding around dot

// ─── Helper: convert PDF page → data URL via canvas ───────────────────────────
async function pdfToDataUrl(file) {
  // Use pdfjs-dist npm package (installed via package.json)
  const pdfjsLib = await import('pdfjs-dist')

  // Worker must point to the bundled worker file inside pdfjs-dist
  // Vite serves node_modules statically so this URL works at runtime
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()

  const arrayBuffer = await file.arrayBuffer()
  const pdf  = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const page = await pdf.getPage(1)

  // scale: 3 → high-res render so hotspots stay sharp after zoom
  const viewport = page.getViewport({ scale: 3 })
  const canvas   = document.createElement('canvas')
  canvas.width   = viewport.width
  canvas.height  = viewport.height

  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
  }).promise

  return canvas.toDataURL('image/png')
}

export default function SiteSetup() {
  const navigate = useNavigate()
  const {
    ready, selectedProject, floors, selectedFloorId, setSelectedFloorId,
    floorPlanUrl, hotspots,
    uploadFloorPlan, addHotspot, removeHotspot, saveLayout,
  } = useSite()

  const selectedFloor = floors.find(f => f.id === selectedFloorId) || null

  // ── Canvas transform (zoom + pan) ────────────────────────────────────────
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const isPanning   = useRef(false)
  const panStart    = useRef({ mx: 0, my: 0, tx: 0, ty: 0 })
  const wrapRef     = useRef(null)    // outer clipping div
  const innerRef    = useRef(null)    // transformed div

  // ── Misc UI state ─────────────────────────────────────────────────────────
  const [saved,       setSaved]       = useState(false)
  const [uploading,   setUploading]   = useState(false)
  const [contextMenu, setContextMenu] = useState(null)   // {x,y,hotspotId,roomId,roomName}
  const [pendingDot,  setPendingDot]  = useState(null)   // {x_pct,y_pct} waiting for modal
  const [units,       setUnits]       = useState([])     // Room IDs for selected floor
  const [areas,       setAreas]       = useState([])     // Areas for the chosen Room ID
  const [roomForm,    setRoomForm]    = useState({ unitId: '', roomId: '' })
  const [hoveredId,   setHoveredId]   = useState(null)
  const fileRef = useRef(null)

  // Reset transform when floor plan changes
  useEffect(() => { setTransform({ x: 0, y: 0, scale: 1 }) }, [floorPlanUrl])

  // Reset save indicator when floor changes
  useEffect(() => { setSaved(false) }, [selectedFloorId])

  // ── Fetch Room IDs (Units) for the selected floor — always the latest from Create Project ──
  useEffect(() => {
    if (!selectedFloorId) { setUnits([]); return }
    getUnits(selectedFloorId).then(({ data }) => setUnits(data)).catch(() => setUnits([]))
  }, [selectedFloorId])

  // ── Fetch Areas (Rooms) for the Room ID chosen in the modal — always the latest ─────────
  useEffect(() => {
    if (!roomForm.unitId) { setAreas([]); return }
    getRooms(roomForm.unitId).then(({ data }) => setAreas(data)).catch(() => setAreas([]))
  }, [roomForm.unitId])

  // Close context menu on outside click
  useEffect(() => {
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // ── Floor plan upload (image OR pdf) ─────────────────────────────────────
  const handleFloorUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return
    setUploading(true)
    try {
      if (file.type === 'application/pdf') {
        const dataUrl = await pdfToDataUrl(file)
        const res  = await fetch(dataUrl)
        const blob = await res.blob()
        const pngFile = new File([blob], file.name.replace('.pdf', '.png'), { type: 'image/png' })
        await uploadFloorPlan(pngFile)
        toast.success('PDF converted & uploaded')
      } else {
        await uploadFloorPlan(file)
        toast.success('Floor plan uploaded')
      }
      setSaved(false)
    } catch (err) {
      toast.error('Upload failed — ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
      toast.error('Only images or PDF allowed'); return
    }
    // Reuse same handler via synthetic event-like object
    await handleFloorUpload({ target: { files: [file], value: '' } })
  }

  // ── Zoom: mouse wheel ─────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const wrap = wrapRef.current; if (!wrap) return
    const rect  = wrap.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const delta  = e.deltaY < 0 ? 1.12 : 1 / 1.12
    setTransform(prev => {
      const newScale = Math.min(8, Math.max(0.3, prev.scale * delta))
      // Keep the point under cursor stationary
      const newX = mouseX - (mouseX - prev.x) * (newScale / prev.scale)
      const newY = mouseY - (mouseY - prev.y) * (newScale / prev.scale)
      return { scale: newScale, x: newX, y: newY }
    })
  }, [])

  useEffect(() => {
    const el = wrapRef.current; if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Pan: mouse drag ───────────────────────────────────────────────────────
  const handleMouseDown = (e) => {
    if (e.button !== 0) return
    // Only pan if not clicking a hotspot
    if (e.target.dataset.hotspot) return
    isPanning.current = true
    panStart.current = { mx: e.clientX, my: e.clientY, tx: transform.x, ty: transform.y }
    e.currentTarget.style.cursor = 'grabbing'
  }
  const handleMouseMove = useCallback((e) => {
    if (!isPanning.current) return
    const dx = e.clientX - panStart.current.mx
    const dy = e.clientY - panStart.current.my
    setTransform(prev => ({ ...prev, x: panStart.current.tx + dx, y: panStart.current.ty + dy }))
  }, [])
  const handleMouseUp = (e) => {
    isPanning.current = false
    if (wrapRef.current) wrapRef.current.style.cursor = floorPlanUrl ? 'crosshair' : 'default'
  }

  // ── Map click → open room metadata modal ─────────────────────────────────
  const handleMapClick = useCallback((e) => {
    if (!floorPlanUrl || isPanning.current) return
    if (e.target.dataset.hotspot) return   // clicked a hotspot, not map
    if (contextMenu) { setContextMenu(null); return }

    const inner = innerRef.current; if (!inner) return
    const rect  = inner.getBoundingClientRect()
    const x_pct = (e.clientX - rect.left) / rect.width
    const y_pct = (e.clientY - rect.top)  / rect.height

    // Hit-test: ignore if clicking near existing dot
    const hit = hotspots.some(h => {
      const px = h.x_pct * rect.width
      const py = h.y_pct * rect.height
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      return Math.hypot(px - cx, py - cy) <= (DOT_D / 2) + HIT_PAD
    })
    if (hit) return

    setPendingDot({ x_pct, y_pct })
    setRoomForm({ unitId: '', roomId: '' })
  }, [floorPlanUrl, hotspots, contextMenu, transform.scale])

  // ── Save dot after modal ──────────────────────────────────────────────────
  const handleRoomModalSave = () => {
    if (!roomForm.unitId) { toast.error('Select a Room ID'); return }
    if (!roomForm.roomId) { toast.error('Select an Area');   return }
    const unit = units.find(u => u.id === roomForm.unitId)
    const area = areas.find(a => a.id === roomForm.roomId)
    addHotspot(pendingDot.x_pct, pendingDot.y_pct, {
      roomId:   unit?.unit_number || '',
      roomName: area?.name || '',
      unitDbId: unit?.id || '',   // real DB ids — needed so Site Capture can persist to the right Room
      areaId:   area?.id || '',
    })
    setPendingDot(null)
    setSaved(false)
    toast.success(`${area?.name} pinned at ${unit?.unit_number} — Floor ${selectedFloor?.floor_number}`)
  }

  // ── Right-click dot → context menu ───────────────────────────────────────
  const handleDotContextMenu = (e, hs) => {
    e.preventDefault(); e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, hotspotId: hs.id,
      roomId: hs.roomId, roomName: hs.roomName })
  }

  // ── Save layout ───────────────────────────────────────────────────────────
  const handleSave = () => {
    if (!floorPlanUrl) { toast.error('Upload a floor plan first'); return }
    const ok = saveLayout()
    if (ok) { setSaved(true); toast.success(`Floor plan saved — ${hotspots.length} hotspot${hotspots.length !== 1 ? 's' : ''}`) }
  }

  const filteredHotspots = hotspots

  if (!ready) return <Loader />

  // ── GATE: no project selected ─────────────────────────────────────────────
  if (!selectedProject) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '70vh', gap: 16 }}>
        <div style={{ fontSize: 52 }}>🏗️</div>
        <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700,
          color: 'var(--text-1)' }}>No active project</h2>
        <p style={{ fontSize: 14, color: 'var(--text-3)', textAlign: 'center', maxWidth: 360 }}>
          Select a project from the <strong>Active Project</strong> dropdown in the sidebar
          before setting up a floor plan.
        </p>
        <button className="btn-primary" onClick={() => navigate('/projects')}>
          Go to Projects →
        </button>
      </div>
    )
  }

  // ── GATE: project has no floors yet ────────────────────────────────────────
  if (!floors.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '70vh', gap: 16 }}>
        <div style={{ fontSize: 52 }}>🏢</div>
        <h2 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700,
          color: 'var(--text-1)' }}>No floors yet</h2>
        <p style={{ fontSize: 14, color: 'var(--text-3)', textAlign: 'center', maxWidth: 360 }}>
          Add a floor (and Room IDs / Areas) for <strong>{selectedProject.name}</strong> in
          Create Project first.
        </p>
        <button className="btn-primary" onClick={() => navigate('/projects')}>
          Go to Create Project →
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 28px', maxWidth: 1300 }}>

      {/* ── Page header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
            <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700,
              color: 'var(--text-1)' }}>Layout Setup</h1>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)',
              background: 'var(--accent-light)', border: '1px solid var(--accent-mid)',
              borderRadius: 20, padding: '3px 10px' }}>
              {selectedProject.name}
            </span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            Choose a floor · Upload floor plan · Click to map hotspots · Save
          </p>
        </div>

        {/* Floor selector + save */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)',
              whiteSpace: 'nowrap' }}>Floor:</label>
            <select
              value={selectedFloorId || ''}
              onChange={e => { setSelectedFloorId(e.target.value); setSaved(false) }}
              style={{ width: 'auto', minWidth: 110, fontWeight: 600 }}
            >
              {floors.map(f => (
                <option key={f.id} value={f.id}>Floor {f.floor_number}</option>
              ))}
            </select>
          </div>
          <button className="btn-primary" onClick={handleSave}
            disabled={!floorPlanUrl} style={{ opacity: !floorPlanUrl ? 0.4 : 1 }}>
            💾 Save Floor Plan
          </button>
          {saved && (
            <button className="btn-ghost" onClick={() => navigate('/site-capture')}
              style={{ borderColor: '#22C55E', color: '#2E7D32' }}>
              → Capture Mode
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14, alignItems: 'start' }}>

        {/* ── LEFT SIDEBAR ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Upload card */}
          <div className="card">
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13,
              marginBottom: 12, color: 'var(--text-1)' }}>
              Floor plan — Floor {selectedFloor?.floor_number}
            </div>
            <button
              className={floorPlanUrl ? 'btn-ghost' : 'btn-primary'}
              onClick={() => fileRef.current?.click()}
              style={{ width: '100%', fontSize: 12 }}
              disabled={uploading}
            >
              {uploading ? '⏳ Processing…' : floorPlanUrl ? '🔄 Replace' : '📁 Upload'}
            </button>
            <input ref={fileRef} type="file" accept="image/*,.pdf"
              style={{ display: 'none' }} onClick={e => e.target.value = ''}
              onChange={handleFloorUpload} />
            <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 6, textAlign: 'center' }}>
              PNG · JPG · PDF supported
            </div>
          </div>

          {/* Zoom controls */}
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 12,
              marginBottom: 10, color: 'var(--text-2)' }}>Zoom & Pan</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
              <button className="btn-ghost" style={{ flex: 1, padding: '6px', fontSize: 14 }}
                onClick={() => setTransform(t => ({ ...t, scale: Math.max(0.3, t.scale / 1.25) }))}>−</button>
              <span style={{ flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 600,
                color: 'var(--text-1)' }}>{Math.round(transform.scale * 100)}%</span>
              <button className="btn-ghost" style={{ flex: 1, padding: '6px', fontSize: 14 }}
                onClick={() => setTransform(t => ({ ...t, scale: Math.min(8, t.scale * 1.25) }))}>+</button>
            </div>
            <button className="btn-ghost" style={{ width: '100%', fontSize: 11 }}
              onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
              ↺ Reset view
            </button>
            <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 8, lineHeight: 1.7 }}>
              🖱 Scroll to zoom<br />
              🖐 Drag to pan
            </div>
          </div>

          {/* Hotspot list */}
          <div className="card" style={{ padding: '14px' }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13,
              marginBottom: 10, color: 'var(--text-1)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Hotspots</span>
              <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-3)' }}>
                {filteredHotspots.length} on F{selectedFloor?.floor_number}
              </span>
            </div>
            {filteredHotspots.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-4)', textAlign: 'center', padding: '12px 0' }}>
                Click the floor plan to add hotspots
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5,
                maxHeight: 300, overflowY: 'auto' }}>
                {filteredHotspots.map(h => (
                  <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px', background: 'var(--bg-hover)', borderRadius: 8,
                    border: '1px solid var(--border-dim)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: '#F5C842', boxShadow: '0 0 5px #F5C842' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {h.roomId}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{h.roomName}</div>
                    </div>
                    <button onClick={() => { removeHotspot(h.id); setSaved(false) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-4)', fontSize: 13, padding: '2px', lineHeight: 1 }}
                      title="Delete">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick instructions */}
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.9 }}>
              <div>1. Choose a floor from the dropdown</div>
              <div>2. Upload or drag-and-drop the floor plan</div>
              <div>3. Scroll to zoom · drag to pan</div>
              <div>4. Click map → enter Room ID &amp; Name</div>
              <div>5. Right-click a dot to delete</div>
              <div>6. Hit <strong style={{ color: 'var(--accent, #D32F2F)' }}>Save Floor Plan</strong></div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Zoomable / pannable floor plan ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>

          {/* Toolbar */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'var(--bg-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#F5C842',
                boxShadow: '0 0 6px #F5C842aa' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
                Floor {selectedFloor?.floor_number} · Mapping mode
              </span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-4)' }}>
              {Math.round(transform.scale * 100)}% zoom
            </span>
          </div>

          {/* Canvas viewport */}
          <div
            ref={wrapRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            style={{
              position: 'relative',
              overflow: 'hidden',
              minHeight: 520,
              background: '#f4f3f0',
              backgroundImage: 'radial-gradient(#d0cfc9 1px, transparent 1px)',
              backgroundSize: '20px 20px',
              cursor: floorPlanUrl ? 'crosshair' : 'default',
              userSelect: 'none',
            }}
          >
            {floorPlanUrl ? (
              /* Transformed inner container */
              <div
                ref={innerRef}
                onClick={handleMapClick}
                style={{
                  position: 'absolute',
                  top: 0, left: 0,
                  transformOrigin: '0 0',
                  transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                  willChange: 'transform',
                  lineHeight: 0,
                }}
              >
                <img
                  src={floorPlanUrl}
                  alt="floor plan"
                  draggable={false}
                  style={{ display: 'block', maxWidth: '100%', userSelect: 'none', pointerEvents: 'none' }}
                />

                {/* Hotspot dots — percentage-based, scale-invariant */}
                {filteredHotspots.map(h => (
                  <HotspotDot
                    key={h.id}
                    hotspot={h}
                    hovered={hoveredId === h.id}
                    zoom={transform.scale}
                    onContextMenu={handleDotContextMenu}
                    onHover={setHoveredId}
                  />
                ))}
              </div>
            ) : (
              /* Empty state */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', minHeight: 520, gap: 14, color: 'var(--text-3)' }}>
                <div style={{ fontSize: 56 }}>🗺️</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)' }}>
                  No floor plan uploaded
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                  Upload an image or PDF using the sidebar, or drag &amp; drop here
                </div>
                <button className="btn-primary" style={{ marginTop: 4 }}
                  onClick={() => fileRef.current?.click()}>
                  Upload floor plan
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Room metadata modal ── */}
      {pendingDot && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, backdropFilter: 'blur(3px)' }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 14, padding: 26, width: 380, maxWidth: '94vw',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)', position: 'relative' }}>
            <div style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)',
              width: 60, height: 2,
              background: 'linear-gradient(90deg, transparent, #D32F2F, transparent)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: '#FFEBEE',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>
                📍
              </div>
              <div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15,
                  color: 'var(--text-1)' }}>New hotspot — Floor {selectedFloor?.floor_number}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                  ({(pendingDot.x_pct * 100).toFixed(1)}%, {(pendingDot.y_pct * 100).toFixed(1)}%)
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label className="label">Room ID <span style={{ color: '#D32F2F' }}>*</span></label>
                <select
                  autoFocus
                  value={roomForm.unitId}
                  onChange={e => setRoomForm({ unitId: e.target.value, roomId: '' })}
                  style={{ marginTop: 5 }}
                >
                  <option value="">
                    {units.length ? 'Select Room ID…' : 'No Room IDs on this floor — add one in Create Project'}
                  </option>
                  {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Area <span style={{ color: '#D32F2F' }}>*</span></label>
                <select
                  value={roomForm.roomId}
                  onChange={e => setRoomForm(f => ({ ...f, roomId: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleRoomModalSave(); if (e.key === 'Escape') setPendingDot(null) }}
                  disabled={!roomForm.unitId}
                  style={{ marginTop: 5 }}
                >
                  <option value="">
                    {!roomForm.unitId ? 'Select a Room ID first' : areas.length ? 'Select area…' : 'No areas for this Room ID — add one in Create Project'}
                  </option>
                  {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 22 }}>
              <button className="btn-primary" onClick={handleRoomModalSave} style={{ flex: 1 }}>
                Pin hotspot
              </button>
              <button className="btn-ghost" onClick={() => setPendingDot(null)} style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Right-click context menu ── */}
      {contextMenu && (
        <div onClick={e => e.stopPropagation()} style={{
          position: 'fixed', left: contextMenu.x, top: contextMenu.y,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 9, padding: 4, zIndex: 1100,
          boxShadow: '0 6px 20px rgba(0,0,0,0.12)', minWidth: 160,
        }}>
          <div style={{ padding: '5px 12px 7px', borderBottom: '1px solid var(--border-dim)',
            marginBottom: 2 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
              {contextMenu.roomId}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{contextMenu.roomName}</div>
          </div>
          <button onClick={async () => {
            await removeHotspot(contextMenu.hotspotId)
            setContextMenu(null); setSaved(false)
          }} style={{ display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', background: 'none', border: 'none', padding: '8px 12px',
            cursor: 'pointer', color: '#C62828', fontSize: 13, borderRadius: 6 }}
            onMouseOver={e => e.currentTarget.style.background = '#FFEBEE'}
            onMouseOut={e => e.currentTarget.style.background = 'none'}>
            🗑️ Delete hotspot
          </button>
        </div>
      )}
    </div>
  )
}

// ─── HotspotDot ──────────────────────────────────────────────────────────────
// Percentage-positioned, zoom-aware, hover scale animation
export function HotspotDot({ hotspot, captured, active, hovered, zoom = 1,
  interactive = true, onContextMenu, onClick, onHover }) {

  // Hit area still scales with zoom so the click target keeps matching the visible dot's
  // on-screen size (percentage-based positioning means the parent's own space is pre-zoom).
  const hitArea = (DOT_D / 2 + HIT_PAD) / (zoom || 1) * 2

  // The dot itself is rendered at a fixed, normal pixel size (crisp — no sub-pixel border/
  // shadow widths) and then scaled down via a GPU transform to counteract the floor plan's
  // zoom. Shrinking the actual width/border to fractional px (the old approach) is what
  // caused the blur at high zoom — transform: scale() stays crisp at any factor.
  const dotScale = (hovered || active ? 1.3 : 1) / (zoom || 1)

  const color = active   ? '#6366F1'
              : captured ? '#22C55E'
              : '#FF4D2E'
  const border = '#000000'

  return (
    <div
      data-hotspot="1"
      title={[hotspot.roomId, hotspot.roomName].filter(Boolean).join(' — ')}
      onClick={e => { e.stopPropagation(); onClick?.(hotspot) }}
      onContextMenu={e => onContextMenu?.(e, hotspot)}
      onMouseEnter={() => onHover?.(hotspot.id)}
      onMouseLeave={() => onHover?.(null)}
      style={{
        position:  'absolute',
        left:      `${hotspot.x_pct * 100}%`,
        top:       `${hotspot.y_pct * 100}%`,
        width:      hitArea,
        height:     hitArea,
        transform: 'translate(-50%, -50%)',
        cursor:    interactive ? 'pointer' : 'default',
        zIndex:    20,
        display:   'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Visual dot — fixed real size, scaled via transform (crisp at any zoom) */}
      <div style={{
        width:        DOT_D,
        height:       DOT_D,
        borderRadius: '50%',
        background:   color,
        border:       `2px solid ${border}`,
        boxShadow:    hovered || active ? `0 0 0 3px ${color}66` : 'none',
        transition:   'transform .15s ease, box-shadow .15s ease',
        transform:    `scale(${dotScale})`,
        pointerEvents: 'none',   // hit area handled by parent
      }} />
    </div>
  )
}

// ─── Loader ──────────────────────────────────────────────────────────────────
function Loader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: 400, flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 26, height: 26, border: '2.5px solid #E5E5E5',
        borderTopColor: '#D32F2F', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
      <div style={{ fontSize: 13, color: '#666' }}>Loading…</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
