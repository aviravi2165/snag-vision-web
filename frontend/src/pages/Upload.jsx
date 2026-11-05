import { useState, useCallback, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import {
  getProjects, getPendingAnalysisCount, startAnalysis, getAnalysisJob,
  getProjectUploads,
} from '../utils/api'

const JOB_POLL_MS = 2500

export default function Upload() {
  const [form, setForm] = useState({ projectId: '' })
  // Media Manager — every capture for the project, grouped by walkthrough,
  // each group carrying its summary row (Total / Pending AI / Done / Failed).
  const [mediaGroups, setMediaGroups] = useState([])

  // ── "Start AI Analysis" — upload only stores files; analysis is triggered
  // explicitly here, then this job is polled until it finishes. ──────────────
  const [pendingCount, setPendingCount] = useState(0)
  const [job, setJob] = useState(null)
  const [startingJob, setStartingJob] = useState(false)
  const pollRef = useRef(null)

  const refreshPendingCount = useCallback(() => {
    if (!form.projectId) return
    getPendingAnalysisCount(form.projectId).then(({ data }) => setPendingCount(data.pending_count)).catch(() => {})
  }, [form.projectId])

  const refreshMedia = useCallback(() => {
    if (!form.projectId) { setMediaGroups([]); return }
    getProjectUploads(form.projectId).then(({ data }) => setMediaGroups(data.groups || [])).catch(() => setMediaGroups([]))
  }, [form.projectId])

  useEffect(() => { refreshPendingCount() }, [refreshPendingCount])
  useEffect(() => { refreshMedia() }, [refreshMedia])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (!job || !form.projectId || ['done', 'failed'].includes(job.status)) return
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await getAnalysisJob(form.projectId, job.id)
        setJob(data)
        if (['done', 'failed'].includes(data.status)) {
          clearInterval(pollRef.current)
          refreshPendingCount()
          refreshMedia()
          toast[data.status === 'done' ? 'success' : 'error'](
            data.status === 'done' ? 'AI analysis complete' : 'AI analysis failed'
          )
        }
      } catch {
        clearInterval(pollRef.current)
      }
    }, JOB_POLL_MS)
    return () => clearInterval(pollRef.current)
  }, [job, form.projectId, refreshPendingCount, refreshMedia])

  const handleStartAnalysis = async () => {
    if (!form.projectId) return
    setStartingJob(true)
    try {
      const { data } = await startAnalysis(form.projectId)
      setJob(data)
      toast.success(`Analyzing ${data.total_images} image(s)…`)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Nothing pending to analyze')
    } finally {
      setStartingJob(false)
    }
  }

  // Scopes the AI Analysis panel and the Media Manager below.
  useEffect(() => {
    getProjects().then(({ data }) => { if (data[0]) setForm(f => ({ ...f, projectId: data[0].id })) })
  }, [])

  return (
    <div style={{ padding: 28, maxWidth: 900 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 4 }}>Upload site media</h1>
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
          Photos and videos are stored immediately. Trigger AI analysis explicitly below when you're
          ready — it runs in the background over every pending upload for the selected project.
        </p>
      </div>

      {/* Start AI Analysis — decoupled from upload; processes every pending
          upload for the selected project via an async job. */}
      {form.projectId && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                AI Analysis
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {pendingCount > 0
                  ? `${pendingCount} photo${pendingCount === 1 ? '' : 's'} uploaded and waiting to be analysed.`
                  : 'No pending photos for this project right now.'}
              </p>
            </div>
            <button className="btn-primary" onClick={handleStartAnalysis}
              disabled={startingJob || pendingCount === 0 || (job && !['done', 'failed'].includes(job.status))}>
              {startingJob ? 'Starting…' : '▶ Start AI Analysis'}
            </button>
          </div>

          {job && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: 'var(--text-2)' }}>
                  {job.status === 'pending' && 'Queued…'}
                  {job.status === 'running' && `Analysing ${job.processed_images}/${job.total_images}…`}
                  {job.status === 'done' && `Done — ${job.processed_images}/${job.total_images} analysed`}
                  {job.status === 'failed' && `Failed — ${job.error_message || 'see server logs'}`}
                </span>
                {job.failed_images > 0 && (
                  <span style={{ color: '#EE6A6A' }}>{job.failed_images} failed</span>
                )}
              </div>
              <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 4,
                  width: `${job.total_images ? Math.round((job.processed_images / job.total_images) * 100) : 0}%`,
                  background: job.status === 'failed' ? '#EE6A6A' : job.status === 'done' ? '#22B96B' : 'var(--amber)',
                  transition: 'width .3s',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Media Manager — grouped by walkthrough, summary per group */}
      {mediaGroups.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 18, marginBottom: 4 }}>
            Media Manager
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
            Every capture for this project, grouped by walkthrough. Captures made before
            walkthroughs existed appear under Legacy.
          </p>

          {mediaGroups.map(g => (
            <div key={g.walkthrough?.id || 'legacy'} className="card" style={{ marginBottom: 16, padding: 18 }}>
              {/* Group header: label + walkthrough status + summary chips */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14, color: 'var(--text-1)' }}>
                    {g.label}
                  </span>
                  {g.walkthrough && (
                    <WalkthroughBadge status={g.walkthrough.status} />
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <SummaryChip label="Total" value={g.summary.total} color="#9AA3C0" />
                  <SummaryChip label="Pending AI" value={g.summary.pending} color="#E8A317" />
                  <SummaryChip label="Done" value={g.summary.done} color="#22B96B" />
                  <SummaryChip label="Failed" value={g.summary.failed} color="#EE6A6A" />
                </div>
              </div>

              {/* File grid */}
              {g.media.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No media in this group.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
                  {g.media.map(m => (
                    <div key={m.id} style={{ borderRadius: 10, overflow: 'hidden',
                      border: '1px solid var(--border)', background: 'var(--bg-hover)' }}>
                      {m.media_type !== 'video' ? (
                        <img src={m.gcs_url} alt={m.file_name || 'capture'}
                          style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }} />
                      ) : (
                        <div style={{ width: '100%', height: 110, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontSize: 26, background: '#111320' }}>
                          🎬
                        </div>
                      )}
                      <div style={{ padding: '8px 10px' }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-1)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}
                          title={m.file_name || ''}>
                          {m.file_name || '(unnamed)'}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>
                          {m.floor_number != null && `Floor ${m.floor_number} · `}
                          {[m.parent_label, m.location_label].filter(Boolean).join(' · ') || 'Unplaced'}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 6 }}>
                          {m.uploaded_at ? new Date(m.uploaded_at).toLocaleDateString() : ''}
                        </div>
                        <UploadStatusBadge status={m.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Small presentational bits for the Media Manager ─────────────────────────

const WT_STATUS_META = {
  draft:             { label: 'Draft',             color: '#9AA3C0' },
  capturing:         { label: 'Capturing',         color: '#E8A317' },
  ready_to_complete: { label: 'Ready to complete', color: '#6E7DEC' },
  completed:         { label: 'Completed',         color: '#22B96B' },
  ai_processing:     { label: 'AI analysing…',     color: '#E8A317' },
  ai_completed:      { label: 'AI complete',       color: '#22B96B' },
}

const UPLOAD_STATUS_META = {
  pending:   { label: 'Pending AI', color: '#E8A317' },
  analysing: { label: 'Analysing',  color: '#98A3F0' },
  done:      { label: 'Done',       color: '#22B96B' },
  failed:    { label: 'Failed',     color: '#EE6A6A' },
}

function WalkthroughBadge({ status }) {
  const meta = WT_STATUS_META[status] || { label: status, color: '#9AA3C0' }
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: meta.color,
      border: `1px solid ${meta.color}33`, background: 'var(--bg-hover)',
      borderRadius: 20, padding: '2px 8px' }}>
      {meta.label}
    </span>
  )
}

function UploadStatusBadge({ status }) {
  const meta = UPLOAD_STATUS_META[status] || { label: status, color: '#9AA3C0' }
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: meta.color }}>● {meta.label}</span>
  )
}

function SummaryChip({ label, value, color }) {
  return (
    <span style={{ fontSize: 11, color: 'var(--text-3)', background: 'var(--bg-hover)',
      border: '1px solid var(--border)', borderRadius: 20, padding: '3px 9px' }}>
      {label}: <span style={{ fontWeight: 700, color }}>{value}</span>
    </span>
  )
}
