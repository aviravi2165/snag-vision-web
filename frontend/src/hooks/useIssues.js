/**
 * useIssues — data layer for the Site Photo Viewer's Issue Management.
 *
 * Project-wide by design: the issue list is meant to be the central place to
 * see and navigate to every issue in the project, not just the ones at the
 * currently selected Floor/Room/Spot. Each issue carries its own location
 * metadata (see backend/routers/issues.py::_LocationLabels), so consumers
 * that need "just the markers for this spot" filter this same list
 * client-side (see PanoramaViewer.jsx::markerIssues) instead of re-fetching.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  getIssues, createIssue, updateIssue, deleteIssue,
  getIssueComments, addIssueComment, getUsers,
} from '../utils/api'

export default function useIssues(projectId) {
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(false)
  const [users, setUsers] = useState([])

  const reload = useCallback(async () => {
    if (!projectId) { setIssues([]); return }
    setLoading(true)
    try {
      const { data } = await getIssues({ project_id: projectId })
      setIssues(data)
    } catch {
      setIssues([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { reload() }, [reload])

  // Assignee directory for the "Assign users" picker
  useEffect(() => {
    getUsers().then(({ data }) => setUsers(data)).catch(() => setUsers([]))
  }, [])

  const create = useCallback(async (payload) => {
    const { data } = await createIssue(payload)
    setIssues(prev => [data, ...prev])
    return data
  }, [])

  const update = useCallback(async (id, patch) => {
    const { data } = await updateIssue(id, patch)
    setIssues(prev => prev.map(i => (i.id === id ? data : i)))
    return data
  }, [])

  const remove = useCallback(async (id) => {
    await deleteIssue(id)
    setIssues(prev => prev.filter(i => i.id !== id))
  }, [])

  const comments = useCallback((id) => getIssueComments(id).then(r => r.data), [])
  const comment = useCallback((id, body) => addIssueComment(id, body).then(r => r.data), [])

  return { issues, loading, users, reload, create, update, remove, comments, comment }
}
