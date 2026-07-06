/**
 * SiteContext.jsx
 * Global state layer for the 2-page hotspot mapping system.
 *
 * Stores:
 *   selectedProject  – string project name
 *   projects         – list of saved projects
 *   floorPlanBase64  – floor plan image as base64 (persisted in localStorage)
 *   hotspots         – [{ id, x_pct, y_pct }] percentage-based coordinates
 *   capturedImages   – { [hotspot_id]: blob_url } mapped from IndexedDB
 *
 * Persistence:
 *   Hotspot metadata + project info → localStorage (lightweight)
 *   Floor plan image + 360° captures → IndexedDB (binary-safe)
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
const DB_NAME    = 'siteiq_site'
const DB_VER     = 1
const STORE_IMGS = 'site_images'

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_IMGS)
    req.onsuccess = e => res(e.target.result)
    req.onerror   = e => rej(e.target.error)
  })
}
async function idbSet(key, value) {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_IMGS, 'readwrite')
    tx.objectStore(STORE_IMGS).put(value, key)
    tx.oncomplete = res
    tx.onerror    = e => rej(e.target.error)
  })
}
async function idbGet(key) {
  const db = await openDB()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE_IMGS, 'readonly').objectStore(STORE_IMGS).get(key)
    req.onsuccess = e => res(e.target.result)
    req.onerror   = e => rej(e.target.error)
  })
}
async function idbDel(key) {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_IMGS, 'readwrite')
    tx.objectStore(STORE_IMGS).delete(key)
    tx.oncomplete = res
    tx.onerror    = e => rej(e.target.error)
  })
}
async function idbKeys() {
  const db = await openDB()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE_IMGS, 'readonly').objectStore(STORE_IMGS).getAllKeys()
    req.onsuccess = e => res(e.target.result)
    req.onerror   = e => rej(e.target.error)
  })
}

// ─── LS keys ──────────────────────────────────────────────────────────────────
const LS_PROJECTS = 'siteiq_projects'      // [{id, name, hotspots}]
const LS_ACTIVE   = 'siteiq_active_project'

// ─── uid ──────────────────────────────────────────────────────────────────────
let _uid = Date.now()
export const genId = () => `hs_${++_uid}`

// ─── Context ──────────────────────────────────────────────────────────────────
const SiteCtx = createContext(null)

export function SiteProvider({ children }) {
  const [projects,       setProjects]       = useState([])
  const [selectedProject, setSelectedProject] = useState(null) // project object
  const [floorPlanUrl,   setFloorPlanUrl]   = useState(null)   // object URL
  const [hotspots,       setHotspots]       = useState([])     // [{id,x_pct,y_pct}]
  const [capturedImages, setCapturedImages] = useState({})     // {id: objectURL}
  const [ready,          setReady]          = useState(false)

  // ── Restore on mount ────────────────────────────────────────────────────────
  useEffect(() => {
    async function restore() {
      try {
        const raw      = localStorage.getItem(LS_PROJECTS)
        const projList = raw ? JSON.parse(raw) : []
        setProjects(projList)

        const activeId = localStorage.getItem(LS_ACTIVE)
        const active   = projList.find(p => p.id === activeId) || projList[0] || null
        if (active) {
          setSelectedProject(active)
          setHotspots(active.hotspots || [])

          // Restore floor plan blob from IndexedDB
          const fpBlob = await idbGet(`fp_${active.id}`).catch(() => null)
          if (fpBlob) setFloorPlanUrl(URL.createObjectURL(fpBlob))

          // Restore captured images for each hotspot
          const caps = {}
          for (const hs of (active.hotspots || [])) {
            const blob = await idbGet(`cap_${hs.id}`).catch(() => null)
            if (blob) caps[hs.id] = URL.createObjectURL(blob)
          }
          setCapturedImages(caps)
        }
      } catch (e) {
        console.warn('[SiteContext] restore error:', e)
      } finally {
        setReady(true)
      }
    }
    restore()
  }, [])

  // ── Persist project list ─────────────────────────────────────────────────
  const persistProjects = useCallback((list) => {
    localStorage.setItem(LS_PROJECTS, JSON.stringify(list))
  }, [])

  // ── Create / select project ─────────────────────────────────────────────
  const createProject = useCallback((name, location = '', floors = 1, rooms = []) => {
    const p = { id: `proj_${Date.now()}`, name, location, floors, rooms, hotspots: [] }
    setProjects(prev => {
      const next = [...prev, p]
      persistProjects(next)
      return next
    })
    setSelectedProject(p)
    setHotspots([])
    setFloorPlanUrl(null)
    setCapturedImages({})
    localStorage.setItem(LS_ACTIVE, p.id)
    return p
  }, [persistProjects])

  const switchProject = useCallback(async (proj) => {
    setSelectedProject(proj)
    setHotspots(proj.hotspots || [])
    localStorage.setItem(LS_ACTIVE, proj.id)

    const fpBlob = await idbGet(`fp_${proj.id}`).catch(() => null)
    setFloorPlanUrl(fpBlob ? URL.createObjectURL(fpBlob) : null)

    const caps = {}
    for (const hs of (proj.hotspots || [])) {
      const blob = await idbGet(`cap_${hs.id}`).catch(() => null)
      if (blob) caps[hs.id] = URL.createObjectURL(blob)
    }
    setCapturedImages(caps)
  }, [])

  // ── Upload floor plan ────────────────────────────────────────────────────
  const uploadFloorPlan = useCallback(async (file) => {
    if (!selectedProject) return
    await idbSet(`fp_${selectedProject.id}`, file)
    const url = URL.createObjectURL(file)
    setFloorPlanUrl(url)
  }, [selectedProject])

  // ── Add hotspot ──────────────────────────────────────────────────────────
  const addHotspot = useCallback((x_pct, y_pct, meta = {}) => {
    const hs = { id: genId(), x_pct, y_pct, ...meta }
    setHotspots(prev => [...prev, hs])
    return hs
  }, [])

  // ── Remove hotspot ───────────────────────────────────────────────────────
  const removeHotspot = useCallback(async (id) => {
    setHotspots(prev => prev.filter(h => h.id !== id))
    setCapturedImages(prev => { const n = { ...prev }; delete n[id]; return n })
    await idbDel(`cap_${id}`).catch(() => {})
  }, [])

  // ── Save layout (commits to localStorage) ───────────────────────────────
  const saveLayout = useCallback(() => {
    if (!selectedProject) return false
    const updated = { ...selectedProject, hotspots }
    setSelectedProject(updated)
    setProjects(prev => {
      const next = prev.map(p => p.id === updated.id ? updated : p)
      persistProjects(next)
      return next
    })
    return true
  }, [selectedProject, hotspots, persistProjects])

  // ── Capture image for a hotspot ──────────────────────────────────────────
  const captureHotspot = useCallback(async (hotspotId, file) => {
    await idbSet(`cap_${hotspotId}`, file)
    const url = URL.createObjectURL(file)
    setCapturedImages(prev => ({ ...prev, [hotspotId]: url }))
    return url
  }, [])

  // ── Remove capture ───────────────────────────────────────────────────────
  const removeCapture = useCallback(async (hotspotId) => {
    await idbDel(`cap_${hotspotId}`).catch(() => {})
    setCapturedImages(prev => { const n = { ...prev }; delete n[hotspotId]; return n })
  }, [])

  return (
    <SiteCtx.Provider value={{
      // state
      ready, projects, selectedProject, floorPlanUrl, hotspots, capturedImages,
      // actions
      createProject, switchProject, uploadFloorPlan,
      addHotspot, removeHotspot, saveLayout,
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
