/**
 * Issues.jsx — standalone project-wide issue list (Snags).
 *
 * Same IssueListPanel the Panorama viewer uses, but on its own page.
 * Clicking an issue shows, right here on this page:
 *   • the photo the marker was placed on (360° draggable sphere for
 *     equirect captures, plain image for flat spot photos), with the pin
 *     exactly where it sits in Panorama — hover shows the issue title,
 *   • the full issue details (status, assignees, comments, delete) below it.
 */
import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useProject } from '../hooks/useProject'
import useIssues from '../hooks/useIssues'
import { getRoomUploads } from '../utils/api'
import IssueListPanel from '../components/issues/IssueListPanel'
import IssueDetailsPanel from '../components/issues/IssueDetailsPanel'
import MarkerLayer from '../components/markers/MarkerLayer'
import { Panorama360 } from './PanoramaViewer'
import { Spinner, Empty } from '../components/UI'

export default function Issues() {
  const { selectedProject } = useProject()
  const issuesApi = useIssues(selectedProject?.id)
  const { issues, loading, users } = issuesApi
  const [selectedId, setSelectedId] = useState(null)

  const selected = issues.find(i => i.id === selectedId) || null

  // The photo the marker was placed on (via the marker's origin_upload_id).
  const [originUpload, setOriginUpload] = useState(null)
  useEffect(() => {
    let cancelled = false
    setOriginUpload(null)
    const m = selected?.marker
    if (!m?.origin_upload_id || !m.location_id) return
    getRoomUploads(m.location_id)
      .then(({ data }) => {
        if (cancelled) return
        setOriginUpload((data || []).find(x => x.id === m.origin_upload_id) || null)
      })
      .catch(() => { if (!cancelled) setOriginUpload(null) })
    return () => { cancelled = true }
  }, [selected])

  if (!selectedProject) {
    return (
      <div style={{ padding: 24 }}>
        <Empty message="No active project" hint="Select a project from the sidebar" />
      </div>
    )
  }

  const m = selected?.marker
  const is360 = m?.space === 'equirect'

  return (
    <div style={{ padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 2 }}>
          {selectedProject.name} — Issues
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {loading ? 'Loading…' : `${issues.length} snag${issues.length === 1 ? '' : 's'} across the project`}
        </p>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1.35fr' : '1fr', gap: 16, alignItems: 'start' }}>
          <div className="card">
            <IssueListPanel
              issues={issues}
              loading={loading}
              users={users}
              currentLocationId={null}
              onSelect={i => setSelectedId(i.id)}
            />
          </div>

          {selected && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="card">
                <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                  📍 Marked on photo
                </div>

                {originUpload ? (
                  is360 ? (
                    <Panorama360
                      src={originUpload.gcs_url}
                      height={360}
                      points={[{ id: m.id, u: m.u, v: m.v }]}
                      focusTo={{ u: m.u, v: m.v }}
                    >
                      {projected => (
                        <MarkerLayer
                          projected={projected}
                          markers={[{
                            id: m.id,
                            status: selected.status,
                            markerType: m.marker_type,
                            title: selected.title,
                          }]}
                          selectedId={m.id}
                        />
                      )}
                    </Panorama360>
                  ) : (
                    <div style={{
                      position: 'relative', display: 'inline-block', maxWidth: '100%',
                      borderRadius: 8, overflow: 'hidden', background: 'var(--bg-base)',
                    }}>
                      <img src={originUpload.gcs_url} alt="Issue photo" style={{
                        display: 'block', maxWidth: '100%', maxHeight: 340, objectFit: 'contain',
                      }} />
                      <div style={{
                        position: 'absolute',
                        left: `${(m.u || 0) * 100}%`,
                        top: `${(m.v || 0) * 100}%`,
                        transform: 'translate(-50%, -100%)',
                        fontSize: 22, lineHeight: 1, filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))',
                      }} title={selected.title}>📍</div>
                    </div>
                  )
                ) : (
                  <Empty message="Original photo not found"
                    hint="The capture this marker was placed on may have been deleted" />
                )}

                {originUpload && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                    {is360 ? '360° photo — drag to look around' : 'Spot photo'}
                    {originUpload.uploaded_at && ` · captured ${new Date(originUpload.uploaded_at).toLocaleDateString()}`}
                  </div>
                )}
              </div>

              <div className="card">
                <IssueDetailsPanel
                  issue={selected}
                  onStatusChange={issuesApi.update}
                  onDelete={async (id) => {
                    await issuesApi.remove(id)
                    setSelectedId(null)
                    toast.success('Issue deleted')
                  }}
                  loadComments={issuesApi.comments}
                  addComment={issuesApi.comment}
                  onBack={() => setSelectedId(null)}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
