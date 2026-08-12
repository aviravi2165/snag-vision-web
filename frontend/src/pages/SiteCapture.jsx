/**
 * SiteCapture.jsx  —  Page 2: Execution & Image Capture Viewport
 *
 * Features:
 *  - Pulls active project, floor plan, hotspots from global SiteContext
 *  - Read-only map — no new dots can be dropped
 *  - Click existing yellow dot → slide-in capture panel
 *  - File/camera upload attaches 360° image to that specific hotspot
 *  - Captured dots glow green with a ✓ badge
 *  - All data persists in IndexedDB via SiteContext
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSite } from '../hooks/SiteContext'
import { HotspotDot } from './SiteSetup'
import WalkthroughBar from '../components/WalkthroughBar'
import { getHotspotCaptureApi } from '../utils/api'
import toast from 'react-hot-toast'

export default function SiteCapture() {
  const navigate  = useNavigate()
  const {
    ready, selectedProject, floors, selectedFloorId, setSelectedFloorId,
    floorPlanUrl, hotspots, capturedImages,
    captureHotspot, removeCapture,
    walkthroughs, currentWalkthrough, walkthroughsReady, nextWalkthroughNumber,
    startWalkthrough, requestComplete, confirmComplete,
  } = useSite()

  // Read-only past-walkthrough viewing: clicking a completed chip in the bar
  // loads that walkthrough's captures (via ?walkthrough_id=) into a separate
  // map so the current captures stay untouched.
  const [viewing,        setViewing]        = useState(null)
  const [viewingImages,  setViewingImages]  = useState({})
  const [busy,           setBusy]           = useState(false)

  const [activeHotspot, setActiveHotspot] = useState(null)   // hotspot object
  const [panelFile,     setPanelFile]     = useState(null)   // File selected in panel
  const [panelPreview,  setPanelPreview]  = useState(null)   // object URL preview
  const [submitting,    setSubmitting]    = useState(false)

  // Which images the UI shows: the current walkthrough's by default, the
  // viewed walkthrough's while in read-only mode.
  const displayImages = viewing ? viewingImages : capturedImages

  const fileRef   = useRef(null)
  const cameraRef = useRef(null)

  // ── Zoom + pan (scroll to zoom, drag to pan) ─────────────────────────────
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const isPanning = useRef(false)
  const panStart  = useRef({ mx: 0, my: 0, tx: 0, ty: 0 })
  const wrapRef   = useRef(null)
  const innerRef  = useRef(null)

  useEffect(() => { setTransform({ x: 0, y: 0, scale: 1 }) }, [floorPlanUrl])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const wrap = wrapRef.current; if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12
    setTransform(prev => {
      const newScale = Math.min(8, Math.max(0.3, prev.scale * delta))
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

  const handleMouseDown = (e) => {
    if (e.button !== 0) return
    if (e.target.dataset.hotspot) return   // don't pan when grabbing a hotspot
    isPanning.current = true
    panStart.current = { mx: e.clientX, my: e.clientY, tx: transform.x, ty: transform.y }
  }
  const handleMouseMove = useCallback((e) => {
    if (!isPanning.current) return
    const dx = e.clientX - panStart.current.mx
    const dy = e.clientY - panStart.current.my
    setTransform(prev => ({ ...prev, x: panStart.current.tx + dx, y: panStart.current.ty + dy }))
  }, [])
  const handleMouseUp = () => { isPanning.current = false }

  // ── Counts ─────────────────────────────────────────────────────────────────
  const totalPoints   = hotspots.length
  const capturedCount = Object.keys(displayImages).length
  const pct           = totalPoints ? Math.round((capturedCount / totalPoints) * 100) : 0
  const canCapture    = !viewing && !!currentWalkthrough

  // ── Open capture panel ─────────────────────────────────────────────────────
  const openPanel = useCallback((hs) => {
    setActiveHotspot(hs)
    setPanelFile(null)
    setPanelPreview(displayImages[hs.id] || null)
  }, [displayImages])

  const closePanel = () => {
    setActiveHotspot(null)
    setPanelFile(null)
    setPanelPreview(null)
  }

  // ── File selected in panel ─────────────────────────────────────────────────
  const handleFileSelect = (e) => {
    const f = e.target.files[0]; if (!f) return
    setPanelFile(f)
    setPanelPreview(URL.createObjectURL(f))
  }

  // ── Confirm capture ────────────────────────────────────────────────────────
  const handleCapture = async () => {
    if (!panelFile || !activeHotspot) return
    if (!canCapture) { toast.error('Start a walkthrough before capturing'); return }
    setSubmitting(true)
    try {
      await captureHotspot(activeHotspot, panelFile)
      toast.success(`Point captured successfully`, { icon: '✅' })
      closePanel()
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Capture failed')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Remove capture ─────────────────────────────────────────────────────────
  const handleRemoveCapture = async () => {
    if (!activeHotspot) return
    if (!canCapture) return
    if (!window.confirm('Remove the latest captured image from this point?')) return
    await removeCapture(activeHotspot.id)
    setPanelPreview(null)
    setPanelFile(null)
    toast.success('Capture removed')
  }

  // ── Close panel on Escape ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') closePanel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Close panel whenever the selected floor changes (its hotspots no longer apply) ──
  useEffect(() => { closePanel() }, [selectedFloorId])

  // ── Close panel when entering/exiting a read-only walkthrough view ──
  useEffect(() => { closePanel() }, [viewing])

  // ── Read-only walkthrough view: load that walkthrough's captures per hotspot ──
  useEffect(() => {
    let cancelled = false
    setViewingImages({})
    if (!viewing || !hotspots.length) return
    ;(async () => {
      const caps = {}
      for (const hs of hotspots) {
        const cap = await getHotspotCaptureApi(hs.id, { walkthrough_id: viewing.id })
          .then(r => r.data).catch(() => null)
        if (cap?.image_url) caps[hs.id] = cap.image_url
      }
      if (!cancelled) setViewingImages(caps)
    })()
    return () => { cancelled = true }
  }, [viewing, hotspots])

  const handleStartWalkthrough = async () => {
    setBusy(true)
    try {
      const wt = await startWalkthrough()
      toast.success(`Walkthrough ${wt?.number ?? ''} started — captures enabled`)
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not start walkthrough')
    } finally {
      setBusy(false)
    }
  }

  const selectedFloor = floors.find(f => f.id === selectedFloorId) || null

  // ── Loading / empty states ─────────────────────────────────────────────────
  if (!ready) return <Loader />

  if (!selectedProject || !floors.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: 500, gap: 16 }}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <div style={{ fontFamily: 'Space Grotesk', fontSize: 18, fontWeight: 600,
          color: 'var(--text-1)' }}>No layout configured</div>
        <div style={{ fontSize: 14, color: 'var(--text-3)', textAlign: 'center', maxWidth: 360 }}>
          Set up your project and floor plan first, then save the layout to begin capturing.
        </div>
        <button className="btn-primary" onClick={() => navigate('/site-setup')}>
          ← Go to Setup
        </button>
      </div>
    )
  }

  const activeIndex = activeHotspot
    ? hotspots.findIndex(h => h.id === activeHotspot.id) + 1
    : null

  return (
    <div style={{ padding: 28, maxWidth: 1200 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <button onClick={() => navigate('/site-setup')} style={{ background: 'none', border: 'none',
              color: 'var(--text-3)', cursor: 'pointer', fontSize: 13, padding: 0 }}>
              ← Setup
            </button>
            <span style={{ color: 'var(--border)' }}>›</span>
            <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700, color: 'var(--text-1)' }}>
              {selectedProject.name}
            </h1>
            <span style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-glow)',
              border: '1px solid var(--amber-dim)', borderRadius: 20, padding: '3px 10px' }}>
              Capture Mode
            </span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            Tap a yellow dot on the floor plan to upload its 360° site photo
          </p>
        </div>

        {/* Progress pills */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <ProgressPill value={capturedCount} label="Captured"  color="#22C55E" />
          <ProgressPill value={totalPoints - capturedCount} label="Remaining" color="#F5C842" />
          <ProgressPill value={pct + '%'} label="Complete" color="#6366F1" />
        </div>
      </div>

      {/* ── Walkthrough bar (history strip + Start/Complete) ── */}
      {walkthroughsReady && (
        <WalkthroughBar
          walkthroughs={walkthroughs}
          current={currentWalkthrough}
          nextNumber={nextWalkthroughNumber}
          viewing={viewing}
          busy={busy}
          onStartWalkthrough={handleStartWalkthrough}
          onRequestComplete={() => requestComplete(currentWalkthrough.id)}
          onConfirmComplete={() => confirmComplete(currentWalkthrough.id)}
          onViewWalkthrough={setViewing}
          onExitView={() => setViewing(null)}
        />
      )}

      {/* ── Progress bar ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`,
            background: pct === 100 ? '#22C55E' : 'var(--amber)',
            borderRadius: 3, transition: 'width .5s ease-out' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {capturedCount} of {totalPoints} points captured
          </span>
          <span style={{ fontSize: 11, color: pct === 100 ? '#4ADE80' : 'var(--text-3)' }}>
            {pct === 100 ? '✓ All points complete' : `${pct}% complete`}
          </span>
        </div>
      </div>

      {/* ── Main layout: map + side panel ── */}
      <div style={{ display: 'grid',
        gridTemplateColumns: activeHotspot ? '1fr 340px' : '1fr',
        gap: 16, alignItems: 'start', transition: 'grid-template-columns .25s ease-out' }}>

        {/* ── Floor plan map (read-only) ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Map header */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: 10, background: 'var(--bg-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
                🗺 {selectedProject.name}
              </span>
              <select
                value={selectedFloorId || ''}
                onChange={e => setSelectedFloorId(e.target.value)}
                disabled={!floors.length}
                style={{ width: 'auto', fontSize: 12, fontWeight: 600 }}
              >
                {!floors.length && <option value="">No floors</option>}
                {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-3)' }}>
              <LegendItem color="#F5C842" label="Pending" />
              <LegendItem color="#22C55E" label="Captured" />
              <LegendItem color="#6366F1" label="Selected" />
            </div>
          </div>

          {/* Interactive map */}
          <div
            ref={wrapRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ position: 'relative', overflow: 'hidden', background: '#0a0c11',
              userSelect: 'none', cursor: floorPlanUrl ? (isPanning.current ? 'grabbing' : 'grab') : 'default' }}
          >
            {!floorPlanUrl ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', minHeight: 360, gap: 10, padding: 24 }}>
                <div style={{ fontSize: 40 }}>🗺️</div>
                <div style={{ fontSize: 14, color: 'var(--text-3)', textAlign: 'center' }}>
                  No floor plan uploaded for Floor {selectedFloor?.floor_number}.
                </div>
                <button onClick={() => navigate('/site-setup')} style={{
                  background: 'none', border: 'none', color: 'var(--amber)',
                  cursor: 'pointer', fontSize: 13, textDecoration: 'underline',
                }}>Go to Setup to upload one →</button>
              </div>
            ) : (
              <div
                ref={innerRef}
                style={{
                  position: 'relative',
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
                  style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }}
                />

                {/* Hotspot dots — percentage based, auto-scale with image */}
                {hotspots.map(h => (
                  <HotspotDot
                    key={h.id}
                    hotspot={h}
                    captured={!!displayImages[h.id]}
                    active={activeHotspot?.id === h.id}
                    interactive={true}
                    zoom={transform.scale}
                    onClick={openPanel}
                  />
                ))}

                {/* Click-anywhere reminder if no dots */}
                {hotspots.length === 0 && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,0.5)' }}>
                    <div style={{ fontSize: 14, color: 'var(--text-3)', textAlign: 'center', padding: 24 }}>
                      No hotspots configured.<br />
                      <button onClick={() => navigate('/site-setup')} style={{
                        background: 'none', border: 'none', color: 'var(--amber)',
                        cursor: 'pointer', fontSize: 14, marginTop: 8, textDecoration: 'underline',
                      }}>Go to Setup to add hotspots →</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Capture side panel (slides in on dot click) ── */}
        {activeHotspot && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Panel card */}
            <div className="card" style={{ position: 'relative' }}>
              {/* Panel header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase',
                    letterSpacing: '.08em', marginBottom: 4 }}>
                    Selected point
                  </div>
                  <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 16,
                    color: 'var(--text-1)' }}>
                    Point #{activeIndex}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                    ({(activeHotspot.x_pct * 100).toFixed(1)}%, {(activeHotspot.y_pct * 100).toFixed(1)}%)
                  </div>
                </div>
                <button onClick={closePanel} style={{ background: 'none', border: 'none',
                  color: 'var(--text-3)', cursor: 'pointer', fontSize: 20, lineHeight: 1,
                  padding: 4 }}>✕</button>
              </div>

              {/* Current capture status */}
              {displayImages[activeHotspot.id] ? (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#4ADE80', marginBottom: 8,
                    display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>✓</span> {viewing ? 'Captured (read-only view)' : '360° image captured'}
                  </div>
                  <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)',
                    position: 'relative' }}>
                    <img src={panelPreview || displayImages[activeHotspot.id]}
                      alt="captured"
                      style={{ width: '100%', maxHeight: 160, objectFit: 'cover', display: 'block' }} />
                    {!viewing && canCapture && (
                      <div style={{ position: 'absolute', top: 6, right: 6 }}>
                        <button onClick={handleRemoveCapture} style={{ background: 'rgba(0,0,0,0.7)',
                          border: 'none', borderRadius: 6, padding: '4px 8px',
                          color: '#F87171', cursor: 'pointer', fontSize: 11 }}>
                          🗑 Remove
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : panelPreview ? (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>
                    Preview — tap Confirm to save
                  </div>
                  <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--amber-dim)',
                    position: 'relative' }}>
                    <img src={panelPreview} alt="preview"
                      style={{ width: '100%', maxHeight: 160, objectFit: 'cover', display: 'block' }} />
                    <button onClick={() => { setPanelFile(null); setPanelPreview(null) }}
                      style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.7)',
                        border: 'none', borderRadius: 6, padding: '4px 8px',
                        color: '#fff', cursor: 'pointer', fontSize: 11 }}>
                      ✕ Clear
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Upload options */}
              {!displayImages[activeHotspot.id] && canCapture && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10 }}>
                    Attach a 360° panoramic photo to this point:
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                    <UploadButton
                      icon="📷" label="Take photo" sub="Use camera"
                      onClick={() => { cameraRef.current.value = ''; cameraRef.current.click() }}
                    />
                    <UploadButton
                      icon="🖼️" label="Upload file" sub="From device"
                      onClick={() => { fileRef.current.value = ''; fileRef.current.click() }}
                    />
                  </div>
                </>
              )}

              {/* No active walkthrough — captures are locked server-side too */}
              {!displayImages[activeHotspot.id] && !canCapture && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', background: 'var(--bg-hover)',
                  border: '1px dashed var(--border)', borderRadius: 10, padding: 14, marginBottom: 8 }}>
                  {viewing
                    ? `Read-only view of Walkthrough ${viewing.number} — no captures can be added.`
                    : 'No active walkthrough — start one above to enable captures.'}
                </div>
              )}

              <input ref={cameraRef} type="file" accept="image/*" capture="environment"
                style={{ display: 'none' }} onChange={handleFileSelect} />
              <input ref={fileRef}   type="file" accept="image/*"
                style={{ display: 'none' }} onChange={handleFileSelect} />

              {/* Confirm/replace button */}
              {panelFile && canCapture && (
                <button
                  className="btn-primary"
                  onClick={handleCapture}
                  disabled={submitting}
                  style={{ width: '100%', padding: '11px', fontSize: 13,
                    background: '#22C55E', opacity: submitting ? 0.6 : 1 }}
                >
                  {submitting ? '⏳ Saving…' : '✓ Confirm & Save'}
                </button>
              )}

              {displayImages[activeHotspot.id] && !panelFile && canCapture && (
                <button
                  className="btn-ghost"
                  onClick={() => { fileRef.current.value = ''; fileRef.current.click() }}
                  style={{ width: '100%', fontSize: 12 }}
                >
                  🔄 Replace image
                </button>
              )}
            </div>

            {/* Navigate between hotspots */}
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10 }}>
                Navigate points
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-ghost" style={{ flex: 1, fontSize: 12 }}
                  disabled={activeIndex <= 1}
                  onClick={() => openPanel(hotspots[activeIndex - 2])}>
                  ← Prev
                </button>
                <span style={{ fontSize: 12, color: 'var(--text-2)', padding: '8px 0',
                  textAlign: 'center', flex: 1 }}>
                  {activeIndex}/{totalPoints}
                </span>
                <button className="btn-ghost" style={{ flex: 1, fontSize: 12 }}
                  disabled={activeIndex >= totalPoints}
                  onClick={() => openPanel(hotspots[activeIndex])}>
                  Next →
                </button>
              </div>
            </div>

            {/* Hotspot list mini */}
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 12,
                marginBottom: 10, color: 'var(--text-1)' }}>
                All points
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5,
                maxHeight: 280, overflowY: 'auto' }}>
                {hotspots.map((h, i) => {
                  const isCaptured = !!capturedImages[h.id]
                  const isActive   = activeHotspot?.id === h.id
                  return (
                    <div key={h.id} onClick={() => openPanel(h)} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                      background: isActive ? 'var(--amber-glow)' : 'var(--bg-hover)',
                      border: `1px solid ${isActive ? 'var(--amber-dim)' : 'transparent'}`,
                      transition: 'all .15s',
                    }}>
                      <div style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                        background: isActive ? '#6366F1' : isCaptured ? '#22C55E' : '#F5C842',
                        boxShadow: `0 0 5px ${isActive ? '#6366F1' : isCaptured ? '#22C55E' : '#F5C842'}` }} />
                      <span style={{ fontSize: 12, flex: 1, color: isActive ? 'var(--amber)' : 'var(--text-2)' }}>
                        Point {i + 1}
                      </span>
                      {isCaptured && (
                        <span style={{ fontSize: 10, color: '#4ADE80', fontWeight: 600 }}>✓</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Small reusable components ────────────────────────────────────────────────
function ProgressPill({ value, label, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-card)',
      border: '1px solid var(--border)', borderRadius: 20, padding: '5px 12px' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{label}:</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)' }}>{value}</span>
    </div>
  )
}

function LegendItem({ color, label }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color,
        display: 'inline-block', boxShadow: `0 0 5px ${color}` }} />
      {label}
    </span>
  )
}

function UploadButton({ icon, label, sub, onClick }) {
  return (
    <button onClick={onClick} style={{ background: 'var(--bg-hover)',
      border: '1.5px dashed var(--border)', borderRadius: 10,
      padding: '16px 8px', cursor: 'pointer', textAlign: 'center',
      color: 'var(--text-2)', width: '100%',
      transition: 'border-color .15s, background .15s' }}
      onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--amber)'; e.currentTarget.style.background = 'var(--amber-glow)' }}
      onMouseOut={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-hover)' }}
    >
      <div style={{ fontSize: 24, marginBottom: 5 }}>{icon}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>{label}</div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>
    </button>
  )
}

function Loader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: 400, flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 26, height: 26, border: '2.5px solid var(--border)',
        borderTopColor: 'var(--amber)', borderRadius: '50%',
        animation: 'spin .7s linear infinite' }} />
      <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Loading…</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
