/**
 * useIssues — data layer for the Site Photo Viewer's Issue Management.
 *
 * Keeps all fetching/mutating in one place so the drawer components stay
 * presentational. Scoped to a `locationId` (the Spot / sub-Room the viewer's
 * 4th filter resolved to) — markers are anchored to the location rather than
 * to one capture, so everything here reloads when the user changes spot, but
 * NOT when they just switch capture date.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  getIssues, createIssue, updateIssue, deleteIssue,
  getIssueComments, addIssueComment, getUsers,
} from '../utils/api'

export default function useIssues(projectId, locationId) {
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(false)
  const [users, setUsers] = useState([])

  const reload = useCallback(async () => {
    if (!locationId) { setIssues([]); return }
    setLoading(true)
    try {
      const { data } = await getIssues({ location_id: locationId })
      setIssues(data)
    } catch {
      setIssues([])
    } finally {
      setLoading(false)
    }
  }, [locationId])

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
