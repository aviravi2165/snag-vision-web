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
import { useSearchParams } from 'react-router-dom'
import * as THREE from 'three'
import toast from 'react-hot-toast'
import { useProject } from '../hooks/useProject'
import { getFloors, getUnits, getRooms, getRoomUploads, getFloorRooms, getRoomSpots } from '../utils/api'
import { Spinner, Empty } from '../components/UI'
import useIssues from '../hooks/useIssues'
import MarkerLayer, { projectFlat } from '../components/markers/MarkerLayer'
import Drawer from '../components/issues/Drawer'
import IssueFormPanel from '../components/issues/IssueFormPanel'
import IssueListPanel from '../components/issues/IssueListPanel'
import IssueDetailsPanel from '../components/issues/IssueDetailsPanel'

function formatDate(isoDate) {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// Tracks an element's rendered size — the flat-photo marker layer needs the
// image's actual box (which `objectFit: contain` shrinks) to place pins.
function useBoxSize() {
  const ref = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

const PENDING_ID = '__pending__'

// ─── Equirect marker coordinates ─────────────────────────────────────────────
// Markers on a 360° sphere are stored as normalized (u, v) in 0..1 rather than
// pixels, so they're independent of image resolution and viewport size:
//   u = (yaw + 180) / 360   (horizontal, full turn)
//   v = (pitch + 90) / 180  (vertical, pole to pole)
// `dirFromUV` is the exact inverse of `uvFromPoint`, so placing a marker and
// re-projecting it round-trips to the same screen position.
const SPHERE_R = 500

function uvFromPoint(p) {
  const yaw = Math.atan2(-p.x, -p.z)                        // -PI..PI
  const pitch = Math.asin(Math.max(-1, Math.min(1, p.y / p.length())))  // -PI/2..PI/2
  return {
    u: (THREE.MathUtils.radToDeg(yaw) + 180) / 360,
    v: (THREE.MathUtils.radToDeg(pitch) + 90) / 180,
  }
}

function dirFromUV(u, v) {
  const yaw = THREE.MathUtils.degToRad(u * 360 - 180)
  const pitch = THREE.MathUtils.degToRad(v * 180 - 90)
  const cosP = Math.cos(pitch)
  return new THREE.Vector3(
    -Math.sin(yaw) * cosP * SPHERE_R,
    Math.sin(pitch) * SPHERE_R,
    -Math.cos(yaw) * cosP * SPHERE_R,
  )
}

// ─── 360° sphere viewer — drag to look around. Each instance is fully independent, ──
// so split comparison mounts two of these side by side with no shared state.
//
// Marker support is opt-in and renderer-agnostic: this component only knows how
// to turn (u, v) into on-screen pixels and hand that list to `children`. It has
// no idea what a marker *means* — issues, AI defects, QA checkpoints all render
// through the same render-prop. Every marker prop is optional, so the plain
// `<Panorama360 src=... />` usage is unchanged.
export function Panorama360({
  src, height = 320,
  points = [],            // [{ id, u, v }] to project
  children,               // (projected) => ReactNode — projected: [{ id, x, y, visible }]
  placementMode = false,  // crosshair + click-to-place
  onPlace,                // (u, v) => void
  focusTo,                // { u, v } — animates the view to centre on this point
  onView,                 // (yawDeg, pitchDeg) => void — fired whenever the user drags this view
  syncTo,                 // { yaw, pitch } (degrees) — jump the camera here, e.g. to mirror another panel
}) {
  const mountRef = useRef(null)
  const rendererRef = useRef(null)
  const meshRef = useRef(null)
  const cameraRef = useRef(null)
  const frameRef = useRef(null)
  const isDragging = useRef(false)
  const didDrag = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const downAt = useRef({ x: 0, y: 0 })
  const yaw = useRef(0)
  const pitch = useRef(0)
  const focusAnim = useRef(null)
  const projectRef = useRef(null)   // lets prop changes re-project without waiting for a frame
  const applyRotationRef = useRef(null)
  // Latest props for the rAF loop / listeners, which are bound once on mount
  const pointsRef = useRef(points)
  const placementRef = useRef(placementMode)
  const onPlaceRef = useRef(onPlace)
  const onViewRef = useRef(onView)
  // Re-project as soon as the marker set changes. The rAF loop covers camera
  // movement, but waiting for a frame to show a just-saved marker is both a
  // visible lag and unreliable when the tab isn't compositing.
  useEffect(() => {
    pointsRef.current = points
    projectRef.current?.()
  }, [points])
  useEffect(() => { placementRef.current = placementMode }, [placementMode])
  useEffect(() => { onPlaceRef.current = onPlace }, [onPlace])
  useEffect(() => { onViewRef.current = onView }, [onView])

  const [projected, setProjected] = useState([])

  // Init Three.js scene once
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const W = mount.clientWidth || 600
    const H = mount.clientHeight || 320

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(75, W / H, 0.1, 1000)
    camera.rotation.order = 'YXZ'
    cameraRef.current = camera
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(W, H)
    renderer.setClearColor(0x0d0f14)
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const geo = new THREE.SphereGeometry(SPHERE_R, 60, 40)
    const mat = new THREE.MeshBasicMaterial({ color: 0x1a1d26, side: THREE.BackSide })
    const mesh = new THREE.Mesh(geo, mat)
    scene.add(mesh)
    meshRef.current = mesh

    yaw.current = 0; pitch.current = 0

    // Re-project markers only when the view actually moved (or the marker set
    // changed) — otherwise this would setState 60x/sec forever. `lastKey` is
    // only committed once a projection actually happens, so a frame that lands
    // while the element has no size doesn't permanently suppress the next one.
    let lastKey = ''
    const projectMarkers = () => {
      const pts = pointsRef.current
      const key = `${yaw.current.toFixed(2)}|${pitch.current.toFixed(2)}|${pts.map(p => p.id).join(',')}`
      if (key === lastKey) return
      const w = mount.clientWidth, h = mount.clientHeight
      if (!w || !h) return
      lastKey = key
      camera.updateMatrixWorld()
      setProjected(pts.map(p => {
        const ndc = dirFromUV(p.u, p.v).project(camera)
        return {
          id: p.id,
          x: (ndc.x * 0.5 + 0.5) * w,
          y: (-ndc.y * 0.5 + 0.5) * h,
          // z >= 1 means the point is behind the camera
          visible: ndc.z < 1 && Math.abs(ndc.x) <= 1.15 && Math.abs(ndc.y) <= 1.15,
        }
      }))
    }

    projectRef.current = projectMarkers

    const applyRotation = () => {
      camera.rotation.y = THREE.MathUtils.degToRad(yaw.current)
      camera.rotation.x = THREE.MathUtils.degToRad(pitch.current)
    }
    applyRotationRef.current = applyRotation

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      // Ease toward a focus target (used when an issue is clicked in the list)
      const f = focusAnim.current
      if (f) {
        yaw.current += (f.yaw - yaw.current) * 0.12
        pitch.current += (f.pitch - pitch.current) * 0.12
        if (Math.abs(f.yaw - yaw.current) < 0.3 && Math.abs(f.pitch - pitch.current) < 0.3) {
          yaw.current = f.yaw; pitch.current = f.pitch
          focusAnim.current = null
        }
        applyRotation()
      }
      projectMarkers()
      renderer.render(scene, camera)
    }
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

    // A click in placement mode drops a marker; a drag looks around. Rather
    // than disabling navigation while placing (which makes the viewer feel
    // broken), we only place when the pointer barely moved between down and up.
    const DRAG_SLOP_PX = 5
    const raycaster = new THREE.Raycaster()
    const placeAt = (clientX, clientY) => {
      if (!placementRef.current || !onPlaceRef.current) return
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObject(mesh)[0]
      if (!hit) return
      const { u, v } = uvFromPoint(hit.point)
      onPlaceRef.current(u, v)
    }

    const onDown = e => {
      isDragging.current = true
      didDrag.current = false
      lastMouse.current = { x: e.clientX, y: e.clientY }
      downAt.current = { x: e.clientX, y: e.clientY }
    }
    const onMove = e => {
      if (!isDragging.current) return
      const dx = e.clientX - lastMouse.current.x
      const dy = e.clientY - lastMouse.current.y
      lastMouse.current = { x: e.clientX, y: e.clientY }
      if (Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > DRAG_SLOP_PX) {
        didDrag.current = true
        focusAnim.current = null   // a manual drag cancels any focus animation
      }
      yaw.current -= dx * 0.3
      pitch.current -= dy * 0.3
      pitch.current = Math.max(-85, Math.min(85, pitch.current))
      applyRotation()
      if (didDrag.current) onViewRef.current?.(yaw.current, pitch.current)
    }
    const onUp = e => {
      const wasDragging = isDragging.current
      isDragging.current = false
      if (wasDragging && !didDrag.current && e && e.clientX !== undefined) {
        placeAt(e.clientX, e.clientY)
      }
    }
    const onTouchStart = e => { const t = e.touches[0]; onDown({ clientX: t.clientX, clientY: t.clientY }) }
    const onTouchMove = e => { const t = e.touches[0]; onMove({ clientX: t.clientX, clientY: t.clientY }) }
    const onTouchEnd = e => {
      const t = e.changedTouches?.[0]
      onUp(t ? { clientX: t.clientX, clientY: t.clientY } : undefined)
    }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    el.addEventListener('touchstart', onTouchStart)
    window.addEventListener('touchmove', onTouchMove)
    window.addEventListener('touchend', onTouchEnd)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(frameRef.current)
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      el.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
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

  // Centre the view on a point (used when an issue is picked from the list).
  // The rAF loop eases toward this; a manual drag cancels it.
  useEffect(() => {
    if (!focusTo) return
    focusAnim.current = {
      yaw: focusTo.u * 360 - 180,
      pitch: Math.max(-85, Math.min(85, focusTo.v * 180 - 90)),
    }
  }, [focusTo])

  // Mirror another panel's camera (split comparison sync). Applied directly,
  // not eased — this fires continuously while the other panel is being
  // dragged, so a direct jump tracks the drag 1:1 instead of lagging behind.
  useEffect(() => {
    if (!syncTo) return
    focusAnim.current = null
    yaw.current = syncTo.yaw
    pitch.current = Math.max(-85, Math.min(85, syncTo.pitch))
    applyRotationRef.current?.()
  }, [syncTo])

  return (
    <div ref={mountRef} style={{
      width: '100%', height: '100%', minHeight: height, borderRadius: 10, overflow: 'hidden',
      background: '#111320',
      cursor: placementMode ? 'crosshair' : src ? 'grab' : 'default',
      position: 'relative',
    }}>
      {loadError && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--red, #DC3A3A)', fontSize: 12, textAlign: 'center', padding: 16,
        }}>
          Couldn't load this image ({src})
        </div>
      )}
      {/* Marker layer — this component supplies screen positions only; what
          gets drawn is entirely the caller's business. */}
      {children ? children(projected) : null}
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
        .then(({ data }) => data.some(x =>
          // '360' is a real equirectangular capture, just as viewable as a flat
          // 'photo' — only an actual video has nothing to show here.
          (x.media_type === 'photo' || x.media_type === '360') && x.status !== 'failed'
        ))
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
          // Same reasoning as hasPhotos() above — a 360 capture is a real,
          // displayable upload and belongs in the Date list too.
          (u.media_type === 'photo' || u.media_type === '360') && u.status !== 'failed' &&
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

  // ── Programmatic navigation (issue list → viewer) ─────────────────────────
  // navigateTo drives the whole Floor→Room ID→Spot→Date cascade at once,
  // driving the level below only once its list of options has actually
  // loaded — the same async chain a user clicking through the dropdowns
  // triggers. `navTarget` is what we're trying to reach; each effect below
  // fires again whenever navTarget changes (even if the underlying list
  // reference didn't), so it works whether we're already on the right
  // floor/unit or need to wait for a fetch.
  const [navTarget, setNavTarget] = useState(null)

  const navigateTo = useCallback(({ floorId: fId, unitId: uId, roomId: rId, dateKey: dKey }) => {
    setNavTarget({ unitId: uId, roomId: rId, dateKey: dKey })
    setFloorId(fId)
  }, [])

  useEffect(() => {
    if (!navTarget?.unitId || unitId === navTarget.unitId) return
    if (units.some(u => u.id === navTarget.unitId)) setUnitId(navTarget.unitId)
  }, [units, navTarget, unitId])

  useEffect(() => {
    if (!navTarget?.roomId || roomId === navTarget.roomId) return
    if (rooms.some(r => r.id === navTarget.roomId)) setRoomId(navTarget.roomId)
  }, [rooms, navTarget, roomId])

  useEffect(() => {
    if (!navTarget?.dateKey || !dateOptions.length) return
    if (dateOptions.some(([k]) => k === navTarget.dateKey)) setDateKey(navTarget.dateKey)
    // If the exact capture is gone (deleted since), fall back to the latest —
    // still lands on the right spot, which is the part that matters most.
    else setDateKey(dateOptions[0][0])
  }, [dateOptions, navTarget])

  return {
    floors, floorId, setFloorId,
    units, unitId, setUnitId, unitsLoading,
    rooms, roomId, setRoomId,
    dateOptions, dateKey, setDateKey,
    activeUpload, loading,
    navigateTo,
  }
}

function FilterPanel({
  title, cascade, viewerHeight = 560,
  projectId, panelKey, drawer, openDrawer, closeDrawer, initialIssueId = null,
  onOrientationChange, syncOrientation, // split-comparison camera sync (equirect panoramas only)
}) {
  const { floors, floorId, setFloorId, units, unitId, setUnitId, unitsLoading,
    rooms, roomId, setRoomId, dateOptions, dateKey, setDateKey,
    activeUpload, loading, navigateTo } = cascade

  // Which kind of room this is (spot = mobile-flow flat Room -> Spot,
  // subroom = hotel-flow Unit -> Room) — used for issue-location taxonomy
  // below, NOT for deciding how to render the photo (see isFlatPhoto).
  const selRoomType = rooms.find(r => r.id === roomId)?.type

  // Sphere vs flat is a property of the PHOTO, not of which room picker path
  // was used to reach it — mobile Spots used to be flat-only (phone camera),
  // but now also receive real 360 equirectangular captures (Ricoh THETA X,
  // stitched on-device), landing in the exact same kind of Spot. Rendering
  // those as flat images made every mobile 360 photo look broken (no drag,
  // no sphere) even though the file itself was a genuine panorama.
  // media_type is set server-side from the actual image dimensions (see
  // backend/services/image_service.py), so this now reflects the photo's
  // real shape regardless of which flow captured it.
  const isFlatPhoto = !!activeUpload && activeUpload.media_type !== '360'

  // ── Issue management ──────────────────────────────────────────────────────
  // Project-wide: the list shows every issue in the project, not just the
  // currently selected Spot — it's the central place to browse and navigate
  // to any issue. `markerIssues` below narrows to the current view only for
  // deciding which pins to actually draw on this panorama.
  const issuesApi = useIssues(projectId)
  const { issues, loading: issuesLoading, users } = issuesApi

  const [pending, setPending] = useState(null)      // {u,v} placed but unsaved
  const [selectedId, setSelectedId] = useState(null) // highlighted marker
  const [focusTo, setFocusTo] = useState(null)       // 360 view centring target
  const [pendingFocusIssueId, setPendingFocusIssueId] = useState(null) // navigating toward this issue
  const [flatRef, flatSize] = useBoxSize()

  const mine = drawer?.panel === panelKey ? drawer : null
  const isPlacing = mine?.mode === 'placing'
  const space = isFlatPhoto ? 'image' : 'equirect'

  // Only issues at THIS spot, in this view's coordinate space, get a pin here.
  const markerIssues = useMemo(
    () => issues.filter(i => i.marker && i.marker.location_id === roomId && i.marker.space === space),
    [issues, roomId, space]
  )
  const points = useMemo(() => {
    const pts = markerIssues.map(i => ({ id: i.marker.id, u: i.marker.u, v: i.marker.v }))
    if (pending) pts.push({ id: PENDING_ID, u: pending.u, v: pending.v })
    return pts
  }, [markerIssues, pending])

  const markerMeta = useMemo(
    () => markerIssues.map(i => ({
      id: i.marker.id, status: i.status, markerType: i.marker.marker_type, title: i.title,
    })),
    [markerIssues]
  )
  const issueByMarkerId = useMemo(
    () => new Map(markerIssues.map(i => [i.marker.id, i])),
    [markerIssues]
  )

  const resetPlacement = useCallback(() => { setPending(null) }, [])

  const handlePlace = useCallback((u, v) => {
    setPending({ u, v })
    openDrawer({ panel: panelKey, mode: 'create' })
  }, [openDrawer, panelKey])

  const handleMarkerClick = useCallback((markerId) => {
    const issue = issueByMarkerId.get(markerId)
    if (!issue) return
    setSelectedId(markerId)
    openDrawer({ panel: panelKey, mode: 'details', issueId: issue.id })
  }, [issueByMarkerId, openDrawer, panelKey])

  // Clicking an issue in the (project-wide) list may point at a different
  // Floor/Room/Spot than what's currently on screen — drive the whole cascade
  // there, then focus the marker and open details once the viewer has
  // actually arrived (see the effect below, keyed off `pendingFocusIssueId`).
  const selectIssue = useCallback((issue) => {
    const m = issue.marker
    if (!m) {
      // No location to navigate to — just show what we have.
      openDrawer({ panel: panelKey, mode: 'details', issueId: issue.id })
      return
    }
    if (roomId === m.location_id && activeUpload) {
      // Already there — no navigation needed, focus immediately.
      setSelectedId(m.id)
      if (m.space === 'equirect') setFocusTo({ u: m.u, v: m.v })
      openDrawer({ panel: panelKey, mode: 'details', issueId: issue.id })
      return
    }
    navigateTo({
      floorId: m.floor_id, unitId: m.parent_location_id, roomId: m.location_id,
      dateKey: m.origin_captured_at ? m.origin_captured_at.slice(0, 10) : null,
    })
    setPendingFocusIssueId(issue.id)
  }, [roomId, activeUpload, navigateTo, openDrawer, panelKey])

  // Deep link: /panorama?issue=<id> auto-selects that issue once loaded — the
  // same click-an-issue flow the Issues page triggers (360 viewer + pin +
  // details drawer, exactly as in Panorama).
  const initialHandled = useRef(false)
  useEffect(() => {
    if (initialHandled.current || !initialIssueId || !issues.length) return
    initialHandled.current = true
    const issue = issues.find(i => i.id === initialIssueId)
    if (issue) selectIssue(issue)
  }, [initialIssueId, issues, selectIssue])

  // Fires once the cascade has actually landed on the target spot with an
  // image loaded — i.e. navigation is visibly complete, not just requested.
  useEffect(() => {
    if (!pendingFocusIssueId || !activeUpload) return
    const issue = issues.find(i => i.id === pendingFocusIssueId)
    if (!issue?.marker) { setPendingFocusIssueId(null); return }
    if (roomId !== issue.marker.location_id) return
    setSelectedId(issue.marker.id)
    if (issue.marker.space === 'equirect') setFocusTo({ u: issue.marker.u, v: issue.marker.v })
    openDrawer({ panel: panelKey, mode: 'details', issueId: issue.id })
    setPendingFocusIssueId(null)
  }, [roomId, activeUpload, pendingFocusIssueId, issues, openDrawer, panelKey])

  const submitIssue = useCallback(async (form) => {
    await issuesApi.create({
      ...form,
      project_id: projectId,
      marker: {
        space, u: pending.u, v: pending.v,
        location_id: roomId,
        location_kind: selRoomType === 'spot' ? 'spot' : 'subroom',
        parent_location_id: unitId,
        floor_id: floorId,
        origin_upload_id: activeUpload?.id || null,
      },
    })
    setPending(null)
    closeDrawer()
    toast.success('Issue created')
  }, [issuesApi, projectId, space, pending, roomId, selRoomType, unitId, floorId, activeUpload, closeDrawer])

  const changeStatus = useCallback(
    (id, status) => issuesApi.update(id, { status }),
    [issuesApi]
  )
  const removeIssue = useCallback(async (id) => {
    await issuesApi.remove(id)
    setSelectedId(null)
    closeDrawer()
    toast.success('Issue deleted')
  }, [issuesApi, closeDrawer])

  // Placing a marker only makes sense against a specific capture
  const canMark = Boolean(activeUpload && roomId)
  const activeIssue = mine?.mode === 'details'
    ? issues.find(i => i.id === mine.issueId) || null
    : null

  const renderMarkers = (projected) => {
    const pend = projected.find(p => p.id === PENDING_ID)
    return (
      <MarkerLayer
        projected={projected.filter(p => p.id !== PENDING_ID)}
        markers={markerMeta}
        selectedId={selectedId}
        onMarkerClick={handleMarkerClick}
        pendingPoint={pend?.visible ? pend : null}
      />
    )
  }

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
        alignItems: 'center', justifyContent: 'center', position: 'relative',
      }}>
        {loading ? (
          <Spinner />
        ) : activeUpload ? (
          isFlatPhoto ? (
            // Wrapper shrinks to the rendered image so markers align to the
            // photo itself, not the letterboxed container around it.
            <div ref={flatRef} style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '100%' }}>
              <img src={activeUpload.gcs_url} alt="Captured spot"
                onClick={e => {
                  if (!isPlacing) return
                  const r = e.currentTarget.getBoundingClientRect()
                  handlePlace((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
                }}
                style={{
                  display: 'block', maxWidth: '100%', maxHeight: viewerHeight,
                  objectFit: 'contain', cursor: isPlacing ? 'crosshair' : 'default',
                }} />
              {renderMarkers(projectFlat(points, flatSize.w, flatSize.h))}
            </div>
          ) : (
            <Panorama360
              src={activeUpload.gcs_url} height={viewerHeight}
              points={points} placementMode={isPlacing} onPlace={handlePlace} focusTo={focusTo}
              onView={onOrientationChange} syncTo={syncOrientation}
            >
              {renderMarkers}
            </Panorama360>
          )
        ) : (
          <Empty message="No image to show"
            hint="Select Floor, Room ID, Spot and Date to view a photo" />
        )}

        {/* ── Floating issue actions — overlaid so the existing layout is untouched ── */}
        {canMark && !mine && (
          <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6, zIndex: 10 }}>
            <FloatingAction onClick={() => openDrawer({ panel: panelKey, mode: 'list' })}>
              ☰ List Issues{issues.length ? ` (${issues.length})` : ''}
            </FloatingAction>
            <FloatingAction onClick={() => openDrawer({ panel: panelKey, mode: 'placing' })}>
              ⚑ Mark Issue
            </FloatingAction>
          </div>
        )}

        {/* Placement-mode helper */}
        {isPlacing && (
          <div style={{
            position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(17,17,17,0.88)', color: '#fff',
            borderRadius: 20, padding: '7px 14px', fontSize: 12,
          }}>
            Click anywhere to place an issue marker
            <button onClick={() => { resetPlacement(); closeDrawer() }} style={{
              background: 'none', border: 'none', color: '#fff',
              cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, opacity: 0.7,
            }}>✕</button>
          </div>
        )}

        {/* ── Issue drawer — rendered inside this panel, but only one panel can
            own the drawer at a time (state lives in PanoramaViewer). ── */}
        <Drawer
          open={Boolean(mine) && mine.mode !== 'placing'}
          title={
            mine?.mode === 'create' ? 'Mark issue'
              : mine?.mode === 'details' ? 'Issue details'
                : 'All issues'
          }
          subtitle={
            mine?.mode === 'list' ? 'Every issue in this project'
              : rooms.find(r => r.id === roomId)?.label
          }
          onClose={() => { resetPlacement(); setSelectedId(null); setPendingFocusIssueId(null); closeDrawer() }}
        >
          {mine?.mode === 'create' && (
            <IssueFormPanel
              users={users}
              onSubmit={submitIssue}
              onCancel={() => { resetPlacement(); closeDrawer() }}
            />
          )}
          {mine?.mode === 'list' && (
            <IssueListPanel
              issues={issues} loading={issuesLoading} users={users}
              currentLocationId={roomId}
              onSelect={selectIssue}
            />
          )}
          {mine?.mode === 'details' && activeIssue && (
            <IssueDetailsPanel
              issue={activeIssue}
              currentUploadId={activeUpload?.id}
              onStatusChange={changeStatus}
              onDelete={removeIssue}
              loadComments={issuesApi.comments}
              addComment={issuesApi.comment}
              onBack={() => openDrawer({ panel: panelKey, mode: 'list' })}
            />
          )}
        </Drawer>
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

function FloatingAction({ onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'rgba(255,255,255,0.94)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '6px 11px', fontSize: 12, cursor: 'pointer',
      color: 'var(--text-1)', boxShadow: '0 1px 6px rgba(0,0,0,0.15)',
      fontFamily: 'inherit', whiteSpace: 'nowrap',
    }}>{children}</button>
  )
}

export default function PanoramaViewer() {
  const { selectedProject } = useProject()
  const [searchParams] = useSearchParams()
  const initialIssueId = searchParams.get('issue') || null
  const [split, setSplit] = useState(false)
  // Which panel owns the issue drawer, and what it's showing. Hoisted here so
  // that in split comparison only one drawer can be open at a time.
  // Shape: { panel: 'left'|'right', mode: 'placing'|'create'|'list'|'details', issueId? }
  const [drawer, setDrawer] = useState(null)
  const openDrawer = useCallback((next) => setDrawer(next), [])
  const closeDrawer = useCallback(() => setDrawer(null), [])

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

  // Synchronized panorama movement: both panels show the same room, so while
  // split, dragging either one's 360° view should rotate the other by the
  // same amount. `orientation` tracks the last drag's {panel, yaw, pitch};
  // each panel is only fed the sync target when it *wasn't* the source, so a
  // panel never fights its own drag.
  const [orientation, setOrientation] = useState(null)
  const handleLeftView = useCallback((yaw, pitch) => setOrientation({ panel: 'left', yaw, pitch }), [])
  const handleRightView = useCallback((yaw, pitch) => setOrientation({ panel: 'right', yaw, pitch }), [])
  useEffect(() => { setOrientation(null) }, [split])

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
          <FilterPanel title="Image 1" cascade={left} viewerHeight={520}
            projectId={selectedProject.id} panelKey="left"
            drawer={drawer} openDrawer={openDrawer} closeDrawer={closeDrawer}
            onOrientationChange={handleLeftView}
            syncOrientation={orientation?.panel === 'right' ? orientation : null} />
          <FilterPanel title="Image 2" cascade={right} viewerHeight={520}
            projectId={selectedProject.id} panelKey="right"
            drawer={drawer} openDrawer={openDrawer} closeDrawer={closeDrawer}
            onOrientationChange={handleRightView}
            syncOrientation={orientation?.panel === 'left' ? orientation : null} />
        </div>
      ) : (
        <FilterPanel cascade={left} viewerHeight={640}
          projectId={selectedProject.id} panelKey="left"
          drawer={drawer} openDrawer={openDrawer} closeDrawer={closeDrawer}
          initialIssueId={initialIssueId} />
      )}
    </div>
  )
}
