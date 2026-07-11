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
import { useAuth } from './useAuth'
import {
  getFloors, uploadMedia,
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
  const { user } = useAuth()

  const [floors,          setFloors]          = useState([])      // real Floor rows for this project
  const [selectedFloorId, setSelectedFloorId] = useState(null)
  const [floorPlanUrl,    setFloorPlanUrl]    = useState(null)    // persisted floor plan for selected floor
  const [hotspots,        setHotspots]        = useState([])      // hotspots for selected floor only
  const [capturedImages,  setCapturedImages]  = useState({})      // {hotspotId: image_url}
  const [ready,           setReady]           = useState(false)

  const selectedFloor = floors.find(f => f.id === selectedFloorId) || null

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

      const caps = {}
      for (const hs of hotspotsOut) {
        const cap = await getHotspotCaptureApi(hs.id).then(r => r.data).catch(() => null)
        if (cap?.image_url) caps[hs.id] = cap.image_url
      }
      if (!cancelled) setCapturedImages(caps)
    }
    restoreFloor()
    return () => { cancelled = true }
  }, [selectedProject, selectedFloor])

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
  // Persists to hotspot_captures (the pinned-point photo shown here) AND, when the
  // hotspot is linked to a real Room, also to /uploads (MediaUpload) so it's
  // AI-analysed and shows up with a real timestamp in the Site Photo Viewer's Date filter.
  const captureHotspot = useCallback(async (hotspot, file) => {
    const fd = new FormData()
    fd.append('file', file)
    const { data } = await captureHotspotApi(hotspot.id, fd)
    setCapturedImages(prev => ({ ...prev, [hotspot.id]: data.image_url }))

    if (hotspot.areaId) {
      const mediaFd = new FormData()
      mediaFd.append('file', file)
      mediaFd.append('room_id', hotspot.areaId)
      mediaFd.append('supervisor_id', user?.id || '')
      mediaFd.append('notes', 'Captured via Site Capture')
      uploadMedia(mediaFd).catch(e => console.warn('[SiteContext] failed to persist capture to backend:', e))
    }

    return data.image_url
  }, [user])

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
      // actions
      uploadFloorPlan, addHotspot, removeHotspot, saveLayout,
      captureHotspot, removeCapture,
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
