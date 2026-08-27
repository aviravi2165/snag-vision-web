import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('siteiq_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Missing/expired token → the backend answers every request with 401. Instead of
// silently failing (blank page, console full of 401s), drop the stale session and
// send the user back to /login so they can sign in again.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && window.location.pathname !== '/login') {
      localStorage.removeItem('siteiq_token')
      localStorage.removeItem('siteiq_user')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api

// ─── Auth ────────────────────────────────────────────────────────────────────
export const login = (email, password) =>
  api.post('/auth/login', { email, password })
export const register = (data) => api.post('/auth/register', data)

// ─── Projects ────────────────────────────────────────────────────────────────
export const getProjects = () => api.get('/projects')
export const createProject = (data) => api.post('/projects', data)
export const getDashboard = (id) => api.get(`/projects/${id}/dashboard`)
export const getFloors = (id) => api.get(`/projects/${id}/floors`)
export const addFloor = (id, data) => api.post(`/projects/${id}/floors`, data)
export const addUnit = (floorId, data) => api.post(`/projects/floors/${floorId}/units`, data)
export const getUnits = (floorId) => api.get(`/projects/floors/${floorId}/units`)
export const addRoom = (unitId, data) => api.post(`/projects/units/${unitId}/rooms`, data)
export const getRooms = (unitId) => api.get(`/projects/units/${unitId}/rooms`)
// "Flat" rooms hang directly off a Floor (no Unit) — this is the mobile app's
// spot-capture flow. Spots are the finest-grained level under those rooms.
export const getFloorRooms = (floorId) => api.get(`/projects/floors/${floorId}/rooms`)
export const getRoomSpots = (roomId) => api.get(`/projects/rooms/${roomId}/spots`)

// ─── Activity Plan (Executive dashboard + AI prompt categories) ─────────────
export const getActivities = (projectId) => api.get(`/projects/${projectId}/activities`)
export const setActivities = (projectId, activities) =>
  api.put(`/projects/${projectId}/activities`, { activities })

// Activity Excel — the uploaded file becomes the project's master progress
// sheet, kept in sync in place (see backend/services/excel_service.py).
export const uploadActivityExcel = (projectId, file) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post(`/projects/${projectId}/activity-excel`, formData,
    { headers: { 'Content-Type': 'multipart/form-data' } })
}
export const getActivityExcel = (projectId) => api.get(`/projects/${projectId}/activity-excel`)
export const downloadActivityExcelUrl = (projectId) => `/api/projects/${projectId}/activity-excel/download`
export const updateUnitMap = (projectId, links) =>
  api.put(`/projects/${projectId}/activity-excel/unit-map`, links)
export const getActivityMapping = (projectId) => api.get(`/projects/${projectId}/activity-mapping`)
export const getUnmappedComponents = (projectId) => api.get(`/projects/${projectId}/unmapped-components`)
// asOf (YYYY-MM-DD) rewinds the matrix to that date; omit it for the latest.
export const getProgressMatrix = (projectId, asOf) =>
  api.get(`/projects/${projectId}/progress`, { params: asOf ? { as_of: asOf } : {} })
// Real overall-completion history — one measured point per capture date.
export const getProgressSeries = (projectId) => api.get(`/projects/${projectId}/progress-series`)
// Manual correction of one AI-scored cell. pct === null is a real value
// ("Cannot Assess"), not a clear — clearing is clearProgressOverride below.
export const overrideProgress = (projectId, { unitId, activityId, pct, note }) =>
  api.put(`/projects/${projectId}/progress/override`, {
    unit_id: unitId, activity_id: activityId, progress_pct: pct, note: note || null,
  })
export const clearProgressOverride = (projectId, { unitId, activityId }) =>
  api.delete(`/projects/${projectId}/progress/override`, {
    params: { unit_id: unitId, activity_id: activityId },
  })

// ─── AI Analysis jobs ("Start AI Analysis" — decoupled from upload) ─────────
export const getPendingAnalysisCount = (projectId) => api.get(`/projects/${projectId}/analysis/pending-count`)
export const startAnalysis = (projectId) => api.post(`/projects/${projectId}/analysis/start`)
export const getAnalysisJobs = (projectId) => api.get(`/projects/${projectId}/analysis/jobs`)
export const getAnalysisJob = (projectId, jobId) => api.get(`/projects/${projectId}/analysis/jobs/${jobId}`)

// ─── Uploads & Analysis ─────────────────────────────────────────────────────
export const uploadMedia = (formData) =>
  api.post('/uploads', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
export const getRoomUploads = (roomId) => api.get(`/uploads/room/${roomId}`)
export const getRoomAnalysis = (roomId) => api.get(`/analysis/room/${roomId}/latest`)
export const getChangeDetection = (roomId) => api.get(`/analysis/room/${roomId}/change-detection`)

// ─── Markers + Issue Management (Site Photo Viewer) ─────────────────────────
// Markers are anchored to a location (the Spot/sub-Room the viewer resolves
// to), not to one capture — so they reappear on later captures of that same
// spot. See backend/routers/issues.py.
export const getUsers = () => api.get('/auth/users')
export const getMarkers = (locationId, markerType) =>
  api.get('/markers', { params: { location_id: locationId, marker_type: markerType } })
export const getIssues = (params) => api.get('/issues', { params })
export const createIssue = (data) => api.post('/issues', data)
export const getIssue = (id) => api.get(`/issues/${id}`)
export const updateIssue = (id, data) => api.patch(`/issues/${id}`, data)
export const deleteIssue = (id) => api.delete(`/issues/${id}`)
export const getIssueComments = (id) => api.get(`/issues/${id}/comments`)
export const addIssueComment = (id, body) => api.post(`/issues/${id}/comments`, { body })

// ─── Walkthroughs (capture sessions — the numbered rounds behind the unified
// media pipeline). Exposed everywhere as "Walkthrough"; the backend table is
// the generic CaptureSession. See backend/services/walkthrough_service.py.
export const getWalkthroughs = (projectId) => api.get(`/projects/${projectId}/walkthroughs`)
export const createWalkthrough = (projectId) => api.post(`/projects/${projectId}/walkthroughs`)
export const getCurrentWalkthrough = (projectId) => api.get(`/projects/${projectId}/walkthroughs/current`)
export const requestCompleteWalkthrough = (walkthroughId) =>
  api.post(`/walkthroughs/${walkthroughId}/request-complete`)
export const completeWalkthrough = (walkthroughId) =>
  api.post(`/walkthroughs/${walkthroughId}/complete`)

// Media Manager — every capture for a project, grouped by walkthrough, each
// group carrying its summary row (Total / Pending AI / Done / Failed).
export const getProjectUploads = (projectId) => api.get(`/uploads/project/${projectId}`)

// ─── Site (Layout Setup / Site Capture / Panorama persistence) ──────────────
export const createSiteProject = (data) => api.post('/site/projects', data)
export const getSiteProjects = () => api.get('/site/projects')
export const getSiteProject = (id) => api.get(`/site/projects/${id}`)

export const uploadFloorPlanApi = (projectId, floorNum, formData) =>
  api.post(`/site/projects/${projectId}/floor-plan/${floorNum}`, formData,
    { headers: { 'Content-Type': 'multipart/form-data' } })
export const getFloorPlanApi = (projectId, floorNum) =>
  api.get(`/site/projects/${projectId}/floor-plan/${floorNum}`)

export const addHotspotApi = (projectId, data) => api.post(`/site/projects/${projectId}/hotspots`, data)
export const getHotspotsApi = (projectId, floorNumber) =>
  api.get(`/site/projects/${projectId}/hotspots`, { params: { floor_number: floorNumber } })
export const deleteHotspotApi = (hotspotId) => api.delete(`/site/hotspots/${hotspotId}`)

export const captureHotspotApi = (hotspotId, formData) =>
  api.post(`/site/hotspots/${hotspotId}/capture`, formData,
    { headers: { 'Content-Type': 'multipart/form-data' } })
export const getHotspotCaptureApi = (hotspotId, params) =>
  api.get(`/site/hotspots/${hotspotId}/capture`, { params })
export const deleteHotspotCaptureApi = (hotspotId) => api.delete(`/site/hotspots/${hotspotId}/capture`)
