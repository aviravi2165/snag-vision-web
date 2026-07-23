/**
 * PanoramaViewer.jsx — Site Photo Viewer
 *
 * Cascading filters: Floor → Room ID (Unit) → Spot (Room/Area, e.g. bathroom,
 * bedroom) → Date. "Room ID" is the Unit created under Create Project (a
 * physical room, e.g. "Room 101"); "Spot" is the specific area/capture point
 * within it. Every dropdown is fetched live from the backend (Create Project
 * is the source of truth for Floor/Room ID/Spot; MediaUpload rows — created
 * permanently, with an automatic timestamp, whenever a photo is captured via
 * Site Capture or the mobile app — are the source of truth for the Date list
 * and the image itself).
 *
 * The image only renders once Floor, Room ID, Spot and Date are all selected.
 * "Split Comparison" duplicates the filter panel so two photos can be viewed side by side,
 * each with fully independent selections.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import * as THREE from 'three'
import { useProject } from '../hooks/useProject'
import { getFloors, getUnits, getRooms, getRoomUploads, getFloorRooms, getRoomSpots } from '../utils/api'
import { Spinner, Empty } from '../components/UI'

function formatDate(isoDate) {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ─── 360° sphere viewer — drag to look around. Each instance is fully independent, ──
// so split comparison mounts two of these side by side with no shared state.
export function Panorama360({ src, height = 320 }) {
  const mountRef = useRef(null)
  const rendererRef = useRef(null)
  const meshRef = useRef(null)
  const frameRef = useRef(null)
  const isDragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const yaw = useRef(0)
  const pitch = useRef(0)

  // Init Three.js scene once
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const W = mount.clientWidth || 600
    const H = mount.clientHeight || 320

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(75, W / H, 0.1, 1000)
    camera.rotation.order = 'YXZ'
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(W, H)
    renderer.setClearColor(0x0d0f14)
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const geo = new THREE.SphereGeometry(500, 60, 40)
    const mat = new THREE.MeshBasicMaterial({ color: 0x1a1d26, side: THREE.BackSide })
    const mesh = new THREE.Mesh(geo, mat)
    scene.add(mesh)
    meshRef.current = mesh

    yaw.current = 0; pitch.current = 0

    const animate = () => { frameRef.current = requestAnimationFrame(animate); renderer.render(scene, camera) }
    animate()

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(mount)

    const el = renderer.domElement
    const onDown = e => { isDragging.current = true; lastMouse.current = { x: e.clientX, y: e.clientY } }
    const onMove = e => {
      if (!isDragging.current) return
      const dx = e.clientX - lastMouse.current.x
      const dy = e.clientY - lastMouse.current.y
      lastMouse.current = { x: e.clientX, y: e.clientY }
      yaw.current -= dx * 0.3
      pitch.current -= dy * 0.3
      pitch.current = Math.max(-85, Math.min(85, pitch.current))
      camera.rotation.y = THREE.MathUtils.degToRad(yaw.current)
      camera.rotation.x = THREE.MathUtils.degToRad(pitch.current)
    }
    const onUp = () => { isDragging.current = false }
    const onTouchStart = e => { const t = e.touches[0]; onDown({ clientX: t.clientX, clientY: t.clientY }) }
    const onTouchMove = e => { const t = e.touches[0]; onMove({ clientX: t.clientX, clientY: t.clientY }) }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.addEventListener('touchstart', onTouchStart)
    window.addEventListener('touchmove', onTouchMove)
    window.addEventListener('touchend', onUp)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(frameRef.current)
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      el.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onUp)
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [])

  // Load/replace the panorama texture whenever the image changes
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    if (!src || !meshRef.current) return
    setLoadError(false)
    const loader = new THREE.TextureLoader()
    loader.load(
      src,
      tex => {
        if (!meshRef.current) return
        tex.needsUpdate = true
        const mat = meshRef.current.material
        mat.map = tex
        mat.color.set(0xffffff)
        mat.needsUpdate = true
      },
      undefined,
      err => {
        console.error('Panorama360: failed to load texture', src, err)
        setLoadError(true)
      }
    )
  }, [src])

  return (
    <div ref={mountRef} style={{
      width: '100%', height: '100%', minHeight: height, borderRadius: 10, overflow: 'hidden',
      background: '#0d0f14', cursor: src ? 'grab' : 'default', position: 'relative',
    }}>
      {loadError && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--red, #e05252)', fontSize: 12, textAlign: 'center', padding: 16,
        }}>
          Couldn't load this image ({src})
        </div>
      )}
    </div>
  )
}

// ─── One independent filter panel (Floor → Room ID → Room Name → Date → Image) ────
function useImageCascade(projectId) {
  const [floors, setFloors] = useState([])
  const [floorId, setFloorId] = useState('')
  const [units, setUnits] = useState([])
  const [unitId, setUnitId] = useState('')
  const [rooms, setRooms] = useState([])
  const [roomId, setRoomId] = useState('')
  const [uploads, setUploads] = useState([])
  const [dateKey, setDateKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [unitsLoading, setUnitsLoading] = useState(false)

  // Floor list — always the latest from Create Project
  useEffect(() => {
    setFloors([]); setFloorId('')
    if (!projectId) return
    getFloors(projectId).then(({ data }) => setFloors(data)).catch(() => setFloors([]))
  }, [projectId])

  // Room ID for the chosen floor — merges two independent data sources:
  // hotel-flow Units (getUnits) and mobile-flow flat Rooms (getFloorRooms,
  // Room.floor_id set directly, no Unit). Each option is tagged with `type`
  // so the next two steps know which endpoint to call.
  //
  // Only kept if it actually has a photo somewhere underneath it -- an
  // empty Unit/Room led straight to "no photos" with nothing to explain
  // why, which is exactly what caused confusion here. This costs an extra
  // round of upload-count checks per candidate, acceptable at this app's
  // scale (a handful of units/rooms per floor).
  useEffect(() => {
    setUnits([]); setUnitId('')
    if (!floorId) return
    let cancelled = false
    setUnitsLoading(true)

    const hasPhotos = (roomId) =>
      getRoomUploads(roomId)
        .then(({ data }) => data.some(x => x.media_type === 'photo' && x.status !== 'failed'))
        .catch(() => false)

    Promise.all([
      getUnits(floorId).catch(() => ({ data: [] })),
      getFloorRooms(floorId).catch(() => ({ data: [] })),
    ]).then(async ([u, r]) => {
      const unitEntries = await Promise.all(u.data.map(async (unit) => {
        const subRooms = await getRooms(unit.id).then((res) => res.data).catch(() => [])
        const anyPhoto = (await Promise.all(subRooms.map((sr) => hasPhotos(sr.id)))).some(Boolean)
        return anyPhoto ? { id: unit.id, label: unit.unit_number, type: 'unit' } : null
      }))
      const roomEntries = await Promise.all(r.data.map(async (room) => (
        (await hasPhotos(room.id)) ? { id: room.id, label: `📍 ${room.name} (site capture)`, type: 'room' } : null
      )))
      if (!cancelled) {
        setUnits([...unitEntries, ...roomEntries].filter(Boolean))
        setUnitsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [floorId])

  // Room Name for the chosen Room ID — sub-Rooms if a hotel Unit was picked,
  // or Spots if a mobile-flow flat Room was picked (spots are the finest
  // level mobile captures against, there's no further sub-room under them).
  useEffect(() => {
    setRooms([]); setRoomId('')
    const sel = units.find(u => u.id === unitId)
    if (!sel) return
    if (sel.type === 'unit') {
      getRooms(unitId)
        .then(({ data }) => setRooms(data.map(x => ({ id: x.id, label: x.name, type: 'subroom' }))))
        .catch(() => setRooms([]))
    } else {
      getRoomSpots(unitId)
        .then(({ data }) => setRooms(data.map(x => ({ id: x.id, label: x.name, type: 'spot' }))))
        .catch(() => setRooms([]))
    }
  }, [unitId, units])

  // Uploaded photos for the chosen Room Name — drives the Date dropdown.
  // A sub-room selection lists its own uploads directly. A spot selection
  // has no room_id of its own to query — uploads are tagged with room_id
  // (the parent flat Room) and, separately, spot_id — so this fetches the
  // parent flat Room's uploads and narrows to the chosen spot client-side.
  useEffect(() => {
    setUploads([]); setDateKey('')
    const selRoom = rooms.find(r => r.id === roomId)
    if (!selRoom) return
    setLoading(true)
    const fetchId = selRoom.type === 'subroom' ? roomId : unitId
    console.log('[PanoramaViewer] fetching uploads:', {
      selectedRoomLabel: selRoom.label, selectedRoomType: selRoom.type,
      roomIdSelected: roomId, fetchIdUsedForApi: fetchId,
    })
    getRoomUploads(fetchId)
      .then(({ data }) => {
        console.log('[PanoramaViewer] raw uploads for', fetchId, ':', data)
        const filtered = data.filter(u =>
          u.media_type === 'photo' && u.status !== 'failed' &&
          (selRoom.type !== 'spot' || u.spot_id === roomId)
        )
        console.log('[PanoramaViewer] filtered uploads (spot match against roomId', roomId, '):', filtered)
        setUploads(filtered)
      })
      .catch((e) => { console.error('[PanoramaViewer] getRoomUploads failed:', e); setUploads([]) })
      .finally(() => setLoading(false))
  }, [roomId, rooms, unitId])

  // One entry per calendar date — latest upload of that date wins
  const dateOptions = useMemo(() => {
    const byDate = new Map()
    for (const u of uploads) {
      const key = u.uploaded_at.slice(0, 10)
      const existing = byDate.get(key)
      if (!existing || new Date(u.uploaded_at) > new Date(existing.uploaded_at)) byDate.set(key, u)
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [uploads])

  const activeUpload = dateOptions.find(([key]) => key === dateKey)?.[1] || null

  return {
    floors, floorId, setFloorId,
    units, unitId, setUnitId, unitsLoading,
    rooms, roomId, setRoomId,
    dateOptions, dateKey, setDateKey,
    activeUpload, loading,
  }
}

function FilterPanel({ title, cascade, viewerHeight = 560 }) {
  const { floors, floorId, setFloorId, units, unitId, setUnitId, unitsLoading,
    rooms, roomId, setRoomId, dateOptions, dateKey, setDateKey,
    activeUpload, loading } = cascade

  // Mobile-captured spot photos are plain flat images, not true 360°
  // equirectangular panoramas — the WebGL sphere viewer expects the latter
  // and fails silently (no visible error) on anything else. Render those
  // as a normal <img> instead; hotel-flow sub-room uploads keep the sphere.
  const selRoomType = rooms.find(r => r.id === roomId)?.type
  const isFlatPhoto = selRoomType === 'spot'

  if (activeUpload) {
    console.log('[PanoramaViewer] activeUpload:', activeUpload,
      '-> image src:', activeUpload.gcs_url, '(spot_id on upload:', activeUpload.spot_id, ', selected roomId:', roomId, ')')
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {title && (
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13 }}>{title}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">Floor</label>
          <select value={floorId} onChange={e => setFloorId(e.target.value)} disabled={!floors.length}>
            <option value="">{floors.length ? 'Select floor…' : 'No floors'}</option>
            {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Room ID</label>
          <select value={unitId} onChange={e => setUnitId(e.target.value)} disabled={!units.length || unitsLoading}>
            <option value="">
              {!floorId ? 'Select floor first' : unitsLoading ? 'Loading…' : units.length ? 'Select Room ID…' : 'No rooms with photos yet'}
            </option>
            {units.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Spot</label>
          <select value={roomId} onChange={e => setRoomId(e.target.value)} disabled={!rooms.length}>
            <option value="">{!unitId ? 'Select Room ID first' : rooms.length ? 'Select spot…' : 'No spots'}</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Date</label>
          <select value={dateKey} onChange={e => setDateKey(e.target.value)} disabled={!dateOptions.length}>
            <option value="">
              {!roomId ? 'Select room first' : dateOptions.length ? 'Select date…' : 'No captures yet'}
            </option>
            {dateOptions.map(([key]) => <option key={key} value={key}>{formatDate(key)}</option>)}
          </select>
        </div>
      </div>

      <div style={{
        borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-dim)',
        background: 'var(--bg-base)', height: viewerHeight, display: 'flex',
        alignItems: 'center', justifyContent: 'center'
      }}>
        {loading ? (
          <Spinner />
        ) : activeUpload ? (
          isFlatPhoto ? (
            <img src={activeUpload.gcs_url} alt="Captured spot"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          ) : (
            <Panorama360 src={activeUpload.gcs_url} height={viewerHeight} />
          )
        ) : (
          <Empty message="No image to show"
            hint="Select Floor, Room ID, Spot and Date to view a photo" />
        )}
      </div>

      {activeUpload && (
        <div style={{
          fontSize: 11, color: 'var(--text-3)', display: 'flex',
          justifyContent: 'space-between'
        }}>
          <span>{isFlatPhoto ? '' : '🖱 Drag to look around'}</span>
          <span>Captured {new Date(activeUpload.uploaded_at).toLocaleDateString()}</span>
        </div>
      )}
    </div>
  )
}

export default function PanoramaViewer() {
  const { selectedProject } = useProject()
  const [split, setSplit] = useState(false)

  // Two independent cascades always exist; only the right one is shown when split is off.
  const left = useImageCascade(selectedProject?.id)
  const right = useImageCascade(selectedProject?.id)

  // Split comparison exists to compare the same location across two dates,
  // so the right panel's Floor/Room ID/Room Name mirror the left panel
  // whenever the left panel's selection changes -- saving a re-pick of the
  // same location twice. Date is deliberately left independent per panel.
  // Every dropdown on the right stays a normal, freely-editable control --
  // this only sets a starting point, it never disables anything.
  useEffect(() => {
    if (split) right.setFloorId(left.floorId)
  }, [split, left.floorId])

  useEffect(() => {
    if (!split || !left.unitId) return
    if (right.units.some(u => u.id === left.unitId)) right.setUnitId(left.unitId)
  }, [split, left.unitId, right.units])

  useEffect(() => {
    if (!split || !left.roomId) return
    if (right.rooms.some(r => r.id === left.roomId)) right.setRoomId(left.roomId)
  }, [split, left.roomId, right.rooms])

  const toggleSplit = useCallback(() => setSplit(s => !s), [])

  return (
    <div style={{ padding: 28, maxWidth: 1800 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 20
      }}>
        <div>
          <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 4 }}>
            Site Photo Viewer
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            Filter by Floor → Room ID → Spot → Date to view a captured photo.
          </p>
        </div>
        <button className="btn-ghost" onClick={toggleSplit}
          style={split ? { borderColor: 'var(--amber)', color: 'var(--amber)' } : undefined}>
          {split ? '✕ Exit split comparison' : '⇆ Split comparison'}
        </button>
      </div>

      {!selectedProject ? (
        <div className="card"><Empty message="No active project"
          hint="Select a project from the sidebar" /></div>
      ) : split ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FilterPanel title="Image 1" cascade={left} viewerHeight={520} />
          <FilterPanel title="Image 2" cascade={right} viewerHeight={520} />
        </div>
      ) : (
        <FilterPanel cascade={left} viewerHeight={640} />
      )}
    </div>
  )
}
