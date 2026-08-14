/**
 * SiteContext.jsx
 * Global state layer for the floor-plan hotspot mapping system (Layout Setup / Site Capture / Panorama).
 *
 * Everything here is persisted to the backend — no localStorage/IndexedDB. Floor →
 * Room ID → Area still comes from the real Floor/Unit/Room hierarchy (Create Project
 * is the source of truth for that, via useProject()+getFloors), so any change made
 * there is picked up automatically the next time a floor is selected. Floor plan
 * images and hotspots (+ their captured photos) are persisted via the `/site/*`
 * endpoints, keyed by the floor's real `floor_number`.
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useProject } from './useProject'
import {
  getFloors,
  getWalkthroughs, createWalkthrough, getCurrentWalkthrough,
  requestCompleteWalkthrough, completeWalkthrough,
  uploadFloorPlanApi, getFloorPlanApi,
  addHotspotApi, getHotspotsApi, deleteHotspotApi,
  captureHotspotApi, getHotspotCaptureApi, deleteHotspotCaptureApi,
} from '../utils/api'

const SiteCtx = createContext(null)

// Backend hotspots only have a single free-text room_name column, so the human-
// readable "Room ID — Area" label is packed into it on write and split back out on read.
const packRoomLabel = (roomId, roomName) => [roomId, roomName].filter(Boolean).join(' — ')
const unpackRoomLabel = (label) => {
  const [roomId = '', roomName = ''] = (label || '').split(' — ')
  return { roomId, roomName }
}

export function SiteProvider({ children }) {
  const { selectedProject } = useProject()

  const [floors,          setFloors]          = useState([])      // real Floor rows for this project
  const [selectedFloorId, setSelectedFloorId] = useState(null)
  const [floorPlanUrl,    setFloorPlanUrl]    = useState(null)    // persisted floor plan for selected floor
  const [hotspots,        setHotspots]        = useState([])      // hotspots for selected floor only
  const [capturedImages,  setCapturedImages]  = useState({})      // {hotspotId: image_url}
  const [ready,           setReady]           = useState(false)
  // Walkthroughs (capture sessions) — the numbered rounds every capture
  // belongs to. `currentWalkthrough` is the one active (non-completed) one;
  // null means the UI shows "Start Walkthrough N" instead of capture controls.
  const [walkthroughs,        setWalkthroughs]        = useState([])
  const [currentWalkthrough,  setCurrentWalkthrough]  = useState(null)
  const [walkthroughsReady,   setWalkthroughsReady]   = useState(false)

  const selectedFloor = floors.find(f => f.id === selectedFloorId) || null

  // ── Walkthroughs — reload whenever the active DB project changes ──────────
  const refreshWalkthroughs = useCallback(async () => {
    if (!selectedProject) {
      setWalkthroughs([]); setCurrentWalkthrough(null); setWalkthroughsReady(true)
      return
    }
    try {
      const { data } = await getWalkthroughs(selectedProject.id)
      setWalkthroughs(data)
    } catch (e) {
      console.warn('[SiteContext] failed to load walkthroughs:', e)
    }
    // 404 = no active walkthrough — that's a normal state ("Start Walkthrough N")
    getCurrentWalkthrough(selectedProject.id)
      .then(({ data }) => setCurrentWalkthrough(data))
      .catch(() => setCurrentWalkthrough(null))
      .finally(() => setWalkthroughsReady(true))
  }, [selectedProject])

  useEffect(() => {
    setWalkthroughsReady(false)
    setWalkthroughs([])
    setCurrentWalkthrough(null)
    refreshWalkthroughs()
  }, [selectedProject, refreshWalkthroughs])

  // The next walkthrough's number is never chosen by the client — the backend
  // computes max+1. This is only for the "Start Walkthrough N" button label.
  const nextWalkthroughNumber = walkthroughs.length
    ? Math.max(...walkthroughs.map(w => w.number)) + 1
    : 1

  const startWalkthrough = useCallback(async () => {
    const projectId = selectedProject?.id
    if (!projectId) return null
    const { data } = await createWalkthrough(projectId)
    await refreshWalkthroughs()
    return data
  }, [selectedProject, refreshWalkthroughs])

  // request-complete returns { walkthrough, warnings } — warnings are the
  // expected-but-uncaptured rooms; the caller shows them in a confirm dialog
  // before calling confirmComplete().
  const requestComplete = useCallback(async (walkthroughId) => {
    const { data } = await requestCompleteWalkthrough(walkthroughId)
    setCurrentWalkthrough(data.walkthrough)
    return data
  }, [])

  const confirmComplete = useCallback(async (walkthroughId) => {
    const { data } = await completeWalkthrough(walkthroughId)
    await refreshWalkthroughs()
    return data
  }, [refreshWalkthroughs])

  // ── Load floors whenever the active DB project changes ─────────────────────
  useEffect(() => {
    let cancelled = false
    async function loadFloors() {
      setReady(false)
      setFloors([])
      setSelectedFloorId(null)
      setFloorPlanUrl(null)
      setHotspots([])
      setCapturedImages({})

      if (!selectedProject) { setReady(true); return }

      try {
        const { data } = await getFloors(selectedProject.id)
        if (cancelled) return
        setFloors(data)
        if (data[0]) setSelectedFloorId(data[0].id)
      } catch (e) {
        console.warn('[SiteContext] failed to load floors:', e)
      } finally {
        if (!cancelled) setReady(true)
      }
    }
    loadFloors()
    return () => { cancelled = true }
  }, [selectedProject])

  // ── Restore floor plan + hotspots (+ their captures) from the backend ──────
  useEffect(() => {
    let cancelled = false
    async function restoreFloor() {
      const projectId = selectedProject?.id
      const floorNum = selectedFloor?.floor_number
      if (!projectId || floorNum === undefined) {
        setFloorPlanUrl(null); setHotspots([]); setCapturedImages({})
        return
      }

      const fp = await getFloorPlanApi(projectId, floorNum).then(r => r.data).catch(() => null)
      if (cancelled) return
      setFloorPlanUrl(fp?.image_url || null)

      const list = await getHotspotsApi(projectId, floorNum).then(r => r.data).catch(() => [])
      if (cancelled) return
      const hotspotsOut = list.map(hs => {
        const { roomId, roomName } = unpackRoomLabel(hs.room_name)
        return { id: hs.id, x_pct: hs.x_pct, y_pct: hs.y_pct, roomId, roomName, areaId: hs.room_id }
      })
      setHotspots(hotspotsOut)

      // Captures are walkthrough-scoped: a dot only glows green if it was
      // captured in the CURRENT walkthrough. Completed/other walkthroughs'
      // captures never leak in — the moment a walkthrough completes (or a new
      // one starts) every dot is red again, ready for re-capture.
      const caps = {}
      const wtId = currentWalkthrough?.id
      if (wtId) {
        for (const hs of hotspotsOut) {
          const cap = await getHotspotCaptureApi(hs.id, { walkthrough_id: wtId })
            .then(r => r.data).catch(() => null)
          if (cap?.image_url) caps[hs.id] = cap.image_url
        }
      }
      if (!cancelled) setCapturedImages(caps)
    }
    restoreFloor()
    return () => { cancelled = true }
  }, [selectedProject, selectedFloor, currentWalkthrough])

  // ── Upload floor plan (scoped to current floor) ─────────────────────────────
  const uploadFloorPlan = useCallback(async (file) => {
    const projectId = selectedProject?.id
    if (!projectId || !selectedFloor) return
    const fd = new FormData()
    fd.append('file', file)
    const { data } = await uploadFloorPlanApi(projectId, selectedFloor.floor_number, fd)
    setFloorPlanUrl(data.image_url)
  }, [selectedProject, selectedFloor])

  // ── Add hotspot (meta carries the real unit/room ids picked from the modal) ─
  const addHotspot = useCallback(async (x_pct, y_pct, meta = {}) => {
    const projectId = selectedProject?.id
    if (!projectId || !selectedFloor) return
    const { data } = await addHotspotApi(projectId, {
      floor_number: selectedFloor.floor_number,
      x_pct, y_pct,
      room_id: meta.areaId || meta.roomId || '',
      room_name: packRoomLabel(meta.roomId, meta.roomName),
    })
    const hs = { id: data.id, x_pct: data.x_pct, y_pct: data.y_pct, roomId: meta.roomId || '', roomName: meta.roomName || '', areaId: meta.areaId || '' }
    setHotspots(prev => [...prev, hs])
    return hs
  }, [selectedProject, selectedFloor])

  // ── Remove hotspot ───────────────────────────────────────────────────────
  const removeHotspot = useCallback(async (id) => {
    await deleteHotspotApi(id).catch(() => {})
    setHotspots(prev => prev.filter(h => h.id !== id))
    setCapturedImages(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [])

  // ── Save layout — hotspots/floor plan are already persisted per-action, so this
  // just confirms there's something to save. Kept for call-site compatibility. ──
  const saveLayout = useCallback(() => {
    return Boolean(selectedProject && selectedFloor)
  }, [selectedProject, selectedFloor])

  // ── Capture image for a hotspot ──────────────────────────────────────────
  // ONE server-side atomic operation now: the backend reads the file once,
  // stores it via the same gcs_service.upload_media() every other path uses,
  // creates the canonical MediaUpload row (stamped into the active walkthrough
  // — 400 if none), and appends a thin HotspotCapture pointer to it. The old
  // second fire-and-forget /uploads call is gone — no double-read, no swallowed
  // error, no orphan writes.
  const captureHotspot = useCallback(async (hotspot, file) => {
    const fd = new FormData()
    fd.append('file', file)
    const { data } = await captureHotspotApi(hotspot.id, fd)
    setCapturedImages(prev => ({ ...prev, [hotspot.id]: data.image_url }))
    // First capture flips draft -> capturing server-side; a capture while
    // ready_to_complete auto-reverts it to capturing. Keep the bar honest.
    refreshWalkthroughs().catch(() => {})
    return data.image_url
  }, [refreshWalkthroughs])

  // ── Remove capture ───────────────────────────────────────────────────────
  const removeCapture = useCallback(async (hotspotId) => {
    await deleteHotspotCaptureApi(hotspotId).catch(() => {})
    setCapturedImages(prev => { const n = { ...prev }; delete n[hotspotId]; return n })
  }, [])

  return (
    <SiteCtx.Provider value={{
      // state
      ready, selectedProject, floors, selectedFloorId, setSelectedFloorId,
      floorPlanUrl, hotspots, capturedImages,
      walkthroughs, currentWalkthrough, walkthroughsReady, nextWalkthroughNumber,
      // actions
      uploadFloorPlan, addHotspot, removeHotspot, saveLayout,
      captureHotspot, removeCapture,
      startWalkthrough, requestComplete, confirmComplete, refreshWalkthroughs,
    }}>
      {children}
    </SiteCtx.Provider>
  )
}

export const useSite = () => {
  const ctx = useContext(SiteCtx)
  if (!ctx) throw new Error('useSite must be used inside <SiteProvider>')
  return ctx
}
