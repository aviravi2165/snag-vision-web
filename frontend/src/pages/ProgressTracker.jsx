/**
 * ProgressTracker.jsx
 * Construction Progress Tracking — 4-phase workflow
 *
 * Phase 1: Project Setup + Floor Plan Upload
 * Phase 2: Yellow Hotspot Mapping (Admin/Planning Mode)
 * Phase 3: On-Site Capture Mode (Worker Walkthrough)
 * Phase 4: AI Batch Analysis (Gemini)
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'

// ─── Constants ────────────────────────────────────────────────────────────────
const DOT_RADIUS = 10

// ─── Colour scheme per hotspot status ────────────────────────────────────────
const STATUS = {
  planned:  { fill: '#E8A317', stroke: '#B8790C', label: '#000' },   // yellow
  captured: { fill: '#22B96B', stroke: '#12A05C', label: '#fff' },   // green
  active:   { fill: '#6E7DEC', stroke: '#2F41C2', label: '#fff' },   // indigo pulse
}

// ─── Utility: file → base64 ────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ─── Mock AI analysis (replace with real Gemini call) ─────────────────────
async function analyzeProgressWithAI(payload) {
  console.log('[AI] Sending payload to Gemini:', payload.map(p => ({
    roomId: p.roomId, timestamp: p.timestamp, hasImage: !!p.imageBase64,
  })))

  // Simulate network delay
  await new Promise(r => setTimeout(r, 2200))

  // Mock structured response mimicking Gemini output
  return payload.map(point => ({
    roomId:     point.roomId,
    timestamp:  point.timestamp,
    overall_pct: Math.floor(Math.random() * 40) + 55,
    components: {
      flooring:           Math.floor(Math.random() * 30) + 70,
      painting:           Math.floor(Math.random() * 50) + 40,
      ceiling:            Math.floor(Math.random() * 40) + 55,
      electrical_fixtures: Math.floor(Math.random() * 60) + 30,
      carpentry_frame:    Math.floor(Math.random() * 30) + 65,
      hardware_fitting:   Math.floor(Math.random() * 50) + 40,
    },
    ai_notes: [
      'Carpentry frame largely complete. Hardware fittings in progress.',
      'Flooring done. False ceiling pending. Electrical incomplete.',
      'Painting 70% — west wall needs second coat. Flooring good.',
      'Site installation underway. Materials delivered and unpacked.',
    ][Math.floor(Math.random() * 4)],
    status: 'analysed',
  }))
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Setup Screen
// ═══════════════════════════════════════════════════════════════════════════════
function SetupScreen({ onSetupComplete }) {
  const [name,    setName]    = useState('')
  const [imgSrc,  setImgSrc]  = useState(null)
  const [imgFile, setImgFile] = useState(null)
  const fileRef = useRef(null)

  const handleImagePick = (e) => {
    const f = e.target.files[0]; if (!f) return
    setImgFile(f)
    setImgSrc(URL.createObjectURL(f))
  }

  const handleStart = () => {
    if (!name.trim()) { toast.error('Enter a project name'); return }
    if (!imgSrc)      { toast.error('Upload a floor plan image'); return }
    onSetupComplete({ name: name.trim(), floorPlanUrl: imgSrc, floorPlanFile: imgFile })
  }

  return (
    <div style={{ maxWidth: 560, margin: '60px auto', padding: '0 16px' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🏗️</div>
        <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 26, fontWeight: 700,
          color: 'var(--text-1)', marginBottom: 6 }}>
          Construction Progress Tracker
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text-3)' }}>
          Set up your project to begin capturing room-by-room progress
        </p>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Project name */}
        <div>
          <label className="label">Project name</label>
          <input
            placeholder="e.g. Radisson Blu, Floor 3"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleStart()}
            style={{ marginTop: 6, fontSize: 15 }}
          />
        </div>

        {/* Floor plan upload */}
        <div>
          <label className="label">Floor plan image</label>
          <div
            onClick={() => fileRef.current?.click()}
            style={{
              marginTop: 6,
              border: `2px dashed ${imgSrc ? 'var(--amber-dim)' : 'var(--border)'}`,
              borderRadius: 12, padding: imgSrc ? 0 : '32px 16px',
              textAlign: 'center', cursor: 'pointer', overflow: 'hidden',
              background: imgSrc ? 'transparent' : 'var(--bg-base)',
              transition: 'border-color .2s',
            }}
          >
            {imgSrc ? (
              <div style={{ position: 'relative' }}>
                <img src={imgSrc} alt="floor plan preview"
                  style={{ width: '100%', maxHeight: 220, objectFit: 'contain',
                    display: 'block', background: '#111320' }} />
                <div style={{ position: 'absolute', bottom: 8, right: 8,
                  background: 'rgba(0,0,0,0.7)', borderRadius: 6, padding: '4px 10px',
                  fontSize: 11, color: 'var(--amber)' }}>
                  Click to change
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🗺️</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>
                  Upload floor plan
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>PNG, JPG, PDF screenshot</div>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={handleImagePick} />
        </div>

        <button className="btn-primary" onClick={handleStart} style={{ padding: '12px', fontSize: 14 }}>
          Start Project →
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 + 3 — Hotspot Modal (label input)
// ═══════════════════════════════════════════════════════════════════════════════
function LabelModal({ pos, existingLabels, onSave, onCancel }) {
  const [label, setLabel] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80) }, [])

  const handleSave = () => {
    const t = label.trim()
    if (!t) { toast.error('Enter a room ID or label'); return }
    if (existingLabels.includes(t)) { toast.error('Label already used'); return }
    onSave(t)
  }

  return (
    <Overlay>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 24, width: 340, maxWidth: '92vw', position: 'relative' }}>
        {/* amber top line */}
        <div style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)',
          width: 70, height: 2, background: 'linear-gradient(90deg, transparent, var(--amber), transparent)' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 20 }}>📍</span>
          <div>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15, color: 'var(--text-1)' }}>
              New hotspot
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              ({Math.round(pos.x_pct * 100)}%, {Math.round(pos.y_pct * 100)}%) on floor plan
            </div>
          </div>
        </div>

        <label className="label">Room ID / Label</label>
        <input
          ref={inputRef}
          placeholder="e.g. Room-101, Corridor-A, Lobby"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel() }}
          style={{ marginTop: 6, marginBottom: 16 }}
        />

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" onClick={handleSave} style={{ flex: 1 }}>Pin hotspot</button>
          <button className="btn-ghost" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
        </div>
      </div>
    </Overlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Capture Modal (camera / file upload)
// ═══════════════════════════════════════════════════════════════════════════════
function CaptureModal({ hotspot, onCapture, onCancel }) {
  const [file,    setFile]    = useState(null)
  const [preview, setPreview] = useState(null)
  const fileRef   = useRef(null)
  const cameraRef = useRef(null)

  const handleFile = (e) => {
    const f = e.target.files[0]; if (!f) return
    setFile(f); setPreview(URL.createObjectURL(f))
  }

  const handleSubmit = async () => {
    if (!file) { toast.error('Capture or upload an image first'); return }
    const base64    = await fileToBase64(file)
    const timestamp = new Date().toISOString()
    onCapture({ file, base64, timestamp })
  }

  return (
    <Overlay>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 16, padding: 24, width: 400, maxWidth: '94vw' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 16, color: 'var(--text-1)' }}>
              📸 Capture — {hotspot.label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              Attach photo to mark this point as visited
            </div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none',
            color: 'var(--text-3)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>✕</button>
        </div>

        {/* Preview */}
        {preview ? (
          <div style={{ marginBottom: 16, borderRadius: 10, overflow: 'hidden',
            border: '1px solid var(--border)', position: 'relative' }}>
            <img src={preview} alt="preview"
              style={{ width: '100%', height: 200, objectFit: 'cover', display: 'block' }} />
            <button onClick={() => { setFile(null); setPreview(null) }}
              style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.7)',
                border: 'none', borderRadius: 20, padding: '4px 10px', color: '#fff',
                cursor: 'pointer', fontSize: 12 }}>
              ✕ Remove
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            {/* Camera capture */}
            <button onClick={() => cameraRef.current?.click()}
              style={{ background: 'var(--bg-hover)', border: '1.5px dashed var(--border)',
                borderRadius: 10, padding: '24px 12px', cursor: 'pointer', textAlign: 'center',
                color: 'var(--text-2)', transition: 'border-color .15s' }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📷</div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Take photo</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>Use camera</div>
            </button>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment"
              style={{ display: 'none' }} onChange={handleFile} />

            {/* File upload */}
            <button onClick={() => fileRef.current?.click()}
              style={{ background: 'var(--bg-hover)', border: '1.5px dashed var(--border)',
                borderRadius: 10, padding: '24px 12px', cursor: 'pointer', textAlign: 'center',
                color: 'var(--text-2)', transition: 'border-color .15s' }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>🖼️</div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Upload image</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>From device</div>
            </button>
            <input ref={fileRef} type="file" accept="image/*"
              style={{ display: 'none' }} onClick={e => e.target.value = ''} onChange={handleFile} />
          </div>
        )}

        {/* Timestamp preview */}
        <div style={{ background: 'var(--bg-hover)', borderRadius: 8, padding: '8px 12px',
          fontSize: 12, color: 'var(--text-3)', marginBottom: 16,
          display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>🕐</span>
          <span>Timestamp will be captured on submit: <strong style={{ color: 'var(--text-2)' }}>
            {new Date().toLocaleString()}
          </strong></span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" onClick={handleSubmit} disabled={!file}
            style={{ flex: 1, opacity: file ? 1 : 0.4 }}>
            ✓ Confirm capture
          </button>
          <button className="btn-ghost" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
        </div>
      </div>
    </Overlay>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 + 3 — Interactive Floor Plan Canvas
// ═══════════════════════════════════════════════════════════════════════════════
function FloorPlanCanvas({ floorPlanUrl, hotspots, mode, activeHotspotId,
  onCanvasClick, onHotspotClick, onHotspotHover }) {

  const canvasRef = useRef(null)
  const imgRef    = useRef(null)
  const wrapRef   = useRef(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })

  // Load image once
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      const maxW  = wrapRef.current?.clientWidth || 900
      const scale = Math.min(1, maxW / img.width)
      const w = Math.round(img.width  * scale)
      const h = Math.round(img.height * scale)
      setCanvasSize({ w, h })
    }
    img.src = floorPlanUrl
  }, [floorPlanUrl])

  // Redraw whenever hotspots, mode, active changes
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img || !canvasSize.w) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    hotspots.forEach(h => {
      const x = h.x_pct * canvas.width
      const y = h.y_pct * canvas.height
      const isActive = h.id === activeHotspotId
      const s = STATUS[isActive ? 'active' : h.status] || STATUS.planned

      // Glow
      ctx.shadowColor = s.fill
      ctx.shadowBlur  = isActive ? 20 : h.status === 'captured' ? 12 : 8

      // Pulse ring for active
      if (isActive) {
        ctx.beginPath(); ctx.arc(x, y, DOT_RADIUS + 8, 0, Math.PI * 2)
        ctx.strokeStyle = s.fill + '55'; ctx.lineWidth = 2; ctx.stroke()
      }

      // Main dot
      ctx.beginPath(); ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = s.fill; ctx.fill()
      ctx.strokeStyle = s.stroke; ctx.lineWidth = 2; ctx.stroke()
      ctx.shadowBlur = 0

      // Label text inside dot
      ctx.fillStyle = s.label
      ctx.font = `bold ${DOT_RADIUS - 1}px Inter, sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(h.label.slice(0, 3).toUpperCase(), x, y)

      // Label bubble above dot
      const bubbleText = h.label
      ctx.font = '10px Inter, sans-serif'
      const tw  = ctx.measureText(bubbleText).width + 12
      const th  = 18
      const bx  = x - tw / 2
      const by  = y - DOT_RADIUS - th - 6

      ctx.fillStyle   = 'rgba(13,15,20,0.88)'
      ctx.strokeStyle = s.fill
      ctx.lineWidth   = 1
      roundRect(ctx, bx, by, tw, th, 4); ctx.fill(); ctx.stroke()

      ctx.fillStyle      = '#F4F6FC'
      ctx.textAlign      = 'center'
      ctx.textBaseline   = 'middle'
      ctx.fillText(bubbleText, x, by + th / 2)

      // Captured check
      if (h.status === 'captured') {
        ctx.fillStyle  = '#22B96B'
        ctx.font       = 'bold 10px Inter, sans-serif'
        ctx.textAlign  = 'center'
        ctx.fillText('✓', x + DOT_RADIUS + 3, y - DOT_RADIUS)
      }
    })
  }, [hotspots, activeHotspotId, canvasSize])

  useEffect(() => { draw() }, [draw])

  const getCanvasPos = (e) => {
    const canvas = canvasRef.current
    const rect   = canvas.getBoundingClientRect()
    const scaleX = canvas.width  / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    }
  }

  const handleClick = (e) => {
    const { x, y } = getCanvasPos(e)
    const canvas = canvasRef.current
    const x_pct  = x / canvas.width
    const y_pct  = y / canvas.height

    // Hit-test hotspot
    const hit = hotspots.find(h => {
      const hx = h.x_pct * canvas.width
      const hy = h.y_pct * canvas.height
      return Math.hypot(hx - x, hy - y) <= DOT_RADIUS + 8
    })

    if (hit) { onHotspotClick(hit); return }
    onCanvasClick({ x_pct, y_pct })
  }

  const handleMouseMove = (e) => {
    const { x, y } = getCanvasPos(e)
    const canvas = canvasRef.current
    const hit = hotspots.find(h => {
      const hx = h.x_pct * canvas.width
      const hy = h.y_pct * canvas.height
      return Math.hypot(hx - x, hy - y) <= DOT_RADIUS + 8
    })
    canvasRef.current.style.cursor = hit ? 'pointer' : (mode === 'planning' ? 'crosshair' : 'default')
    onHotspotHover(hit || null)
  }

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      {canvasSize.w > 0 && (
        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => onHotspotHover(null)}
          style={{ display: 'block', maxWidth: '100%', borderRadius: 8 }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4 — AI Report display
// ═══════════════════════════════════════════════════════════════════════════════
function AIReport({ results, onReset }) {
  const overall = Math.round(
    results.reduce((s, r) => s + r.overall_pct, 0) / results.length
  )

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Summary header */}
      <div className="card" style={{
        marginBottom: 16,
        background: 'linear-gradient(135deg, var(--bg-card), #181B2B)',
        borderColor: 'var(--amber-dim)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase',
            letterSpacing: '.08em', marginBottom: 4 }}>AI Analysis Complete</div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 28, fontWeight: 700,
            color: 'var(--amber)', lineHeight: 1 }}>
            {overall}% overall
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {results.length} room{results.length !== 1 ? 's' : ''} analysed by Gemini 2.5 Flash
          </div>
        </div>
        <button className="btn-ghost" onClick={onReset} style={{ fontSize: 12 }}>
          ↩ New session
        </button>
      </div>

      {/* Per-room cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {results.map((r, i) => (
          <div key={r.roomId} className="card">
            {/* Room header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14, color: 'var(--text-1)' }}>
                  {r.roomId}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {new Date(r.timestamp).toLocaleString()}
                </div>
              </div>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: `conic-gradient(${pctColor(r.overall_pct)} ${r.overall_pct}%, var(--border) 0%)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%',
                  background: 'var(--bg-card)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 11, fontWeight: 700, color: pctColor(r.overall_pct) }}>
                  {r.overall_pct}%
                </div>
              </div>
            </div>

            {/* Component bars */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {Object.entries(r.components).map(([k, v]) => (
                <div key={k}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'capitalize' }}>
                      {k.replace(/_/g, ' ')}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: pctColor(v) }}>{v}%</span>
                  </div>
                  <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${v}%`, background: pctColor(v),
                      borderRadius: 2, transition: 'width .4s ease-out' }} />
                  </div>
                </div>
              ))}
            </div>

            {/* AI notes */}
            {r.ai_notes && (
              <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--bg-hover)',
                borderRadius: 8, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6,
                borderLeft: '2px solid var(--amber-dim)' }}>
                {r.ai_notes}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main ProgressTracker page
// ═══════════════════════════════════════════════════════════════════════════════
export default function ProgressTracker() {
  // ── Core state ─────────────────────────────────────────────────────────────
  const [phase,    setPhase]    = useState('setup')   // setup | tracker | report
  const [project,  setProject]  = useState(null)
  const [hotspots, setHotspots] = useState([])
  const [mode,     setMode]     = useState('planning') // planning | capture

  // ── UI helpers ─────────────────────────────────────────────────────────────
  const [labelModal,   setLabelModal]   = useState(null)   // { x_pct, y_pct }
  const [captureModal, setCaptureModal] = useState(null)   // hotspot object
  const [activeHsId,   setActiveHsId]  = useState(null)
  const [hoveredHs,    setHoveredHs]   = useState(null)
  const [analyzing,    setAnalyzing]   = useState(false)
  const [aiResults,    setAiResults]   = useState(null)

  // ── Phase 1 complete ───────────────────────────────────────────────────────
  const handleSetupComplete = ({ name, floorPlanUrl }) => {
    setProject({ name, floorPlanUrl })
    setPhase('tracker')
    toast.success(`Project "${name}" ready — start pinning hotspots`)
  }

  // ── Add hotspot (after label modal) ───────────────────────────────────────
  const handleAddHotspot = (label) => {
    const hs = {
      id:        `hs_${Date.now()}`,
      x_pct:     labelModal.x_pct,
      y_pct:     labelModal.y_pct,
      label,
      status:    'planned',
      image:     null,
      imageBase64: null,
      timestamp: null,
    }
    setHotspots(prev => [...prev, hs])
    setLabelModal(null)
    toast.success(`Hotspot "${label}" pinned`)
  }

  // ── Canvas click ───────────────────────────────────────────────────────────
  const handleCanvasClick = ({ x_pct, y_pct }) => {
    if (mode !== 'planning') return
    setLabelModal({ x_pct, y_pct })
  }

  // ── Hotspot click ──────────────────────────────────────────────────────────
  const handleHotspotClick = (hs) => {
    if (mode === 'planning') {
      // Planning mode: allow relabelling or just highlight
      setActiveHsId(prev => prev === hs.id ? null : hs.id)
      return
    }
    // Capture mode: open capture modal
    setActiveHsId(hs.id)
    setCaptureModal(hs)
  }

  // ── Capture confirmed ──────────────────────────────────────────────────────
  const handleCapture = ({ file, base64, timestamp }) => {
    setHotspots(prev => prev.map(h =>
      h.id === captureModal.id
        ? { ...h, status: 'captured', image: URL.createObjectURL(file), imageBase64: base64, timestamp }
        : h
    ))
    setCaptureModal(null)
    setActiveHsId(null)
    toast.success(`✓ ${captureModal.label} captured`, { icon: '📸' })
  }

  // ── Delete hotspot ─────────────────────────────────────────────────────────
  const handleDelete = (id) => {
    if (!window.confirm('Delete this hotspot?')) return
    setHotspots(prev => prev.filter(h => h.id !== id))
    if (activeHsId === id) setActiveHsId(null)
  }

  // ── AI submit ──────────────────────────────────────────────────────────────
  const handleAISubmit = async () => {
    const captured = hotspots.filter(h => h.status === 'captured')
    if (!captured.length) { toast.error('No captured points to analyse'); return }

    setAnalyzing(true)
    toast.loading('Sending to Gemini 2.5 Flash…', { id: 'ai' })

    try {
      const payload = captured.map(h => ({
        roomId:      h.label,
        imageBase64: h.imageBase64,
        timestamp:   h.timestamp,
      }))
      const results = await analyzeProgressWithAI(payload)
      setAiResults(results)
      setPhase('report')
      toast.success('Analysis complete!', { id: 'ai' })
    } catch (e) {
      toast.error('AI analysis failed', { id: 'ai' })
      console.error(e)
    } finally {
      setAnalyzing(false)
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const totalPlanned  = hotspots.length
  const totalCaptured = hotspots.filter(h => h.status === 'captured').length
  const canSubmit     = totalCaptured > 0 && !analyzing

  // ────────────────────────────────────────────────────────────────────────────
  if (phase === 'setup') return <SetupScreen onSetupComplete={handleSetupComplete} />

  if (phase === 'report') return (
    <div style={{ padding: 28 }}>
      <AIReport results={aiResults} onReset={() => {
        setPhase('setup'); setProject(null); setHotspots([])
        setMode('planning'); setAiResults(null)
      }} />
    </div>
  )

  // ── Main tracker UI ────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 28, maxWidth: 1200 }}>
      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700, marginBottom: 2 }}>
            {project.name}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {mode === 'planning'
              ? '🟡 Planning mode — click floor plan to drop hotspots'
              : '📸 Capture mode — click a yellow dot to upload photo'}
          </p>
        </div>

        {/* Stats pills */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatPill label="Planned" value={totalPlanned}  color="#E8A317" />
          <StatPill label="Captured" value={totalCaptured} color="#22B96B" />
          <StatPill label="Remaining" value={totalPlanned - totalCaptured} color="#E5484D" />
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>

        {/* Mode toggle */}
        <div style={{ display: 'flex', background: 'var(--bg-base)', borderRadius: 8,
          border: '1px solid var(--border)', overflow: 'hidden' }}>
          {[
            { key: 'planning', icon: '📐', label: 'Planning' },
            { key: 'capture',  icon: '📸', label: 'Capture'  },
          ].map(m => (
            <button key={m.key} onClick={() => { setMode(m.key); setActiveHsId(null) }} style={{
              padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: mode === m.key ? 'var(--amber)' : 'transparent',
              color:      mode === m.key ? '#111320'       : 'var(--text-3)',
              transition: 'all .15s',
            }}>
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        {/* Hints */}
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {mode === 'planning'
            ? 'Click anywhere on the floor plan to pin a room'
            : 'Click a yellow dot on the floor plan to capture its photo'}
        </div>

        {/* Submit button */}
        <button
          className="btn-primary"
          style={{ marginLeft: 'auto', opacity: canSubmit ? 1 : 0.35,
            background: canSubmit ? '#22B96B' : undefined, fontSize: 13 }}
          disabled={!canSubmit}
          onClick={handleAISubmit}
        >
          {analyzing ? '⏳ Analysing…' : `🤖 Submit ${totalCaptured} for AI Analysis`}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, alignItems: 'start' }}>
        {/* ── Floor plan canvas ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <FloorPlanCanvas
            floorPlanUrl={project.floorPlanUrl}
            hotspots={hotspots}
            mode={mode}
            activeHotspotId={activeHsId}
            onCanvasClick={handleCanvasClick}
            onHotspotClick={handleHotspotClick}
            onHotspotHover={setHoveredHs}
          />
          {/* Footer hint */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-dim)',
            display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-3)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#E8A317', display: 'inline-block' }} />
              Planned
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22B96B', display: 'inline-block' }} />
              Captured
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#6E7DEC', display: 'inline-block' }} />
              Active
            </span>
          </div>
        </div>

        {/* ── Right panel: hotspot list + hovered preview ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Hovered hotspot preview */}
          {hoveredHs && (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>Hovered</div>
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 15,
                color: 'var(--text-1)', marginBottom: 4 }}>{hoveredHs.label}</div>
              <span className={`badge ${hoveredHs.status === 'captured' ? 'badge-green' : 'badge-amber'}`}>
                {hoveredHs.status}
              </span>
              {hoveredHs.image && (
                <img src={hoveredHs.image} alt={hoveredHs.label}
                  style={{ width: '100%', borderRadius: 8, marginTop: 10,
                    maxHeight: 120, objectFit: 'cover', border: '1px solid var(--border)' }} />
              )}
              {hoveredHs.timestamp && (
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
                  📷 {new Date(hoveredHs.timestamp).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {/* Hotspot list */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13,
              marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Hotspots ({hotspots.length})</span>
              {hotspots.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {totalCaptured}/{totalPlanned} done
                </span>
              )}
            </div>

            {hotspots.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '16px 0' }}>
                No hotspots yet — switch to Planning mode and click the floor plan
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                {hotspots.map(h => (
                  <div key={h.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8,
                    background: activeHsId === h.id ? 'var(--amber-glow)' : 'var(--bg-hover)',
                    border: `1px solid ${activeHsId === h.id ? 'var(--amber-dim)' : 'transparent'}`,
                    cursor: 'pointer', transition: 'all .15s',
                  }}
                    onClick={() => {
                      setActiveHsId(h.id)
                      if (mode === 'capture') setCaptureModal(h)
                    }}
                  >
                    {/* Status dot */}
                    <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                      background: h.status === 'captured' ? '#22B96B' : '#E8A317',
                      boxShadow: `0 0 6px ${h.status === 'captured' ? '#22B96B' : '#E8A317'}` }} />

                    {/* Label + timestamp */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {h.label}
                      </div>
                      {h.timestamp && (
                        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                          {new Date(h.timestamp).toLocaleTimeString()}
                        </div>
                      )}
                    </div>

                    {/* Status badge */}
                    <span className={`badge ${h.status === 'captured' ? 'badge-green' : 'badge-amber'}`}
                      style={{ fontSize: 9 }}>
                      {h.status === 'captured' ? '✓' : '⏳'}
                    </span>

                    {/* Delete */}
                    <button onClick={e => { e.stopPropagation(); handleDelete(h.id) }} style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-3)', fontSize: 14, lineHeight: 1, padding: 2,
                      flexShrink: 0,
                    }} title="Delete">🗑</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Progress bar */}
          {hotspots.length > 0 && (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Capture progress</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: pctColor(totalCaptured / totalPlanned * 100) }}>
                  {Math.round(totalCaptured / totalPlanned * 100)}%
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3,
                  width: `${(totalCaptured / totalPlanned) * 100}%`,
                  background: pctColor(totalCaptured / totalPlanned * 100),
                  transition: 'width .4s ease-out',
                }} />
              </div>
              {canSubmit && (
                <div style={{ marginTop: 10, fontSize: 11, color: '#3ECF86', textAlign: 'center' }}>
                  ✓ Ready to submit for AI analysis
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Modals ── */}
      {labelModal && (
        <LabelModal
          pos={labelModal}
          existingLabels={hotspots.map(h => h.label)}
          onSave={handleAddHotspot}
          onCancel={() => setLabelModal(null)}
        />
      )}

      {captureModal && (
        <CaptureModal
          hotspot={captureModal}
          onCapture={handleCapture}
          onCancel={() => { setCaptureModal(null); setActiveHsId(null) }}
        />
      )}
    </div>
  )
}

// ─── Small helpers ────────────────────────────────────────────────────────────
function Overlay({ children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, backdropFilter: 'blur(4px)' }}>
      {children}
    </div>
  )
}

function StatPill({ label, value, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 20, padding: '5px 12px' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{label}:</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)' }}>{value}</span>
    </div>
  )
}

function pctColor(pct) {
  if (pct >= 80) return '#22B96B'
  if (pct >= 50) return '#E8A317'
  return '#E5484D'
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
