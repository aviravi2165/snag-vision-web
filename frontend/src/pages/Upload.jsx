import { useState, useCallback, useEffect, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import toast from 'react-hot-toast'
import {
  getProjects, getFloors, getUnits, getRooms, uploadMedia,
  getPendingAnalysisCount, startAnalysis, getAnalysisJob,
  getProjectUploads,
} from '../utils/api'
import { useAuth } from '../hooks/useAuth'

const JOB_POLL_MS = 2500

export default function Upload() {
  const { user } = useAuth()
  const [projects, setProjects] = useState([])
  const [floors, setFloors] = useState([])
  const [units, setUnits] = useState([])
  const [rooms, setRooms] = useState([])
  const [form, setForm] = useState({ projectId: '', floorId: '', unitId: '', roomId: '', notes: '' })
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState([])
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

  useEffect(() => {
    getProjects().then(({ data }) => { setProjects(data); if (data[0]) setForm(f => ({ ...f, projectId: data[0].id })) })
  }, [])
  useEffect(() => {
    if (!form.projectId) return
    getFloors(form.projectId).then(({ data }) => { setFloors(data); if (data[0]) setForm(f => ({ ...f, floorId: data[0].id })) })
  }, [form.projectId])
  useEffect(() => {
    if (!form.floorId) return
    getUnits(form.floorId).then(({ data }) => { setUnits(data); if (data[0]) setForm(f => ({ ...f, unitId: data[0].id })) })
  }, [form.floorId])
  useEffect(() => {
    if (!form.unitId) return
    getRooms(form.unitId).then(({ data }) => { setRooms(data); if (data[0]) setForm(f => ({ ...f, roomId: data[0].id })) })
  }, [form.unitId])

  const onDrop = useCallback((accepted) => setFiles(p => [...p, ...accepted]), [])
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: { 'image/*': [], 'video/*': [] }, multiple: true })

  const removeFile = (i) => setFiles(f => f.filter((_, idx) => idx !== i))

  const handleSubmit = async () => {
    if (!form.roomId) { toast.error('Select a room'); return }
    if (!files.length) { toast.error('Add at least one photo'); return }
    setUploading(true)
    const res = []
    for (const file of files) {
      try {
        const fd = new FormData()
        fd.append('file', file); fd.append('room_id', form.roomId)
        fd.append('supervisor_id', user?.id || 'demo'); fd.append('notes', form.notes)
        const { data } = await uploadMedia(fd)
        res.push({ name: file.name, status: 'ok', id: data.id })
        toast.success(`${file.name} uploaded`)
      } catch {
        res.push({ name: file.name, status: 'error' })
        toast.error(`Failed: ${file.name}`)
      }
    }
    setResults(res); setFiles([]); setUploading(false)
    refreshPendingCount()
    refreshMedia()
  }

  return (
    <div style={{ padding: 28, maxWidth: 900 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 4 }}>Upload site media</h1>
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
          Photos and videos are stored immediately. Trigger AI analysis explicitly below when you're
          ready — it runs in the background over every pending upload for the selected project.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Metadata */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 2 }}>Site metadata</div>

          <div>
            <label className="label">Project</label>
            <select value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label className="label">Floor</label>
              <select value={form.floorId} onChange={e => setForm({ ...form, floorId: e.target.value })}>
                {floors.map(f => <option key={f.id} value={f.id}>Floor {f.floor_number}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Unit</label>
              <select value={form.unitId} onChange={e => setForm({ ...form, unitId: e.target.value })}>
                {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Room</label>
            <select value={form.roomId} onChange={e => setForm({ ...form, roomId: e.target.value })}>
              {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          <div>
            <label className="label">Site notes</label>
            <textarea rows={3} style={{ resize: 'none' }} placeholder="What work was done? Any issues observed..."
              value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>

        {/* Upload */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 2 }}>Upload files</div>

          <div {...getRootProps()} className={`dropzone${isDragActive ? ' active' : ''}`}>
            <input {...getInputProps()} />
            <div style={{ fontSize: 28, marginBottom: 10 }}>📷</div>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, color: 'var(--text-1)', marginBottom: 4 }}>
              {isDragActive ? 'Drop here...' : 'Drag photos, videos, 360° scans'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>JPG, PNG, MP4, MOV · Max 20 MB</div>
          </div>

          {files.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8,
                  background: 'var(--bg-hover)', borderRadius: 8, padding: '7px 10px' }}>
                  <span style={{ fontSize: 14 }}>🖼</span>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 6 }}>{(f.size/1024).toFixed(0)} KB</span>
                  <button onClick={() => removeFile(i)} style={{
                    background: 'none', border: 'none', color: 'var(--text-3)',
                    cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 2,
                  }}>✕</button>
                </div>
              ))}
            </div>
          )}

          <button onClick={handleSubmit} className="btn-primary" disabled={uploading || !files.length} style={{ marginTop: 'auto' }}>
            {uploading ? 'Uploading...' : `Upload${files.length ? ` (${files.length})` : ''}`}
          </button>
        </div>
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
                  <span style={{ color: '#F87171' }}>{job.failed_images} failed</span>
                )}
              </div>
              <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 4,
                  width: `${job.total_images ? Math.round((job.processed_images / job.total_images) * 100) : 0}%`,
                  background: job.status === 'failed' ? '#F87171' : job.status === 'done' ? '#22C55E' : 'var(--amber)',
                  transition: 'width .3s',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Upload results</div>
          {results.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 0', borderBottom: i < results.length-1 ? '1px solid var(--border-dim)' : 'none' }}>
              <span style={{ fontSize: 15 }}>{r.status === 'ok' ? '✅' : '❌'}</span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-2)' }}>{r.name}</span>
              <span style={{ fontSize: 12, fontWeight: 500, color: r.status === 'ok' ? '#4ADE80' : '#F87171' }}>
                {r.status === 'ok' ? 'Uploaded — pending analysis' : 'Failed'}
              </span>
            </div>
          ))}
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
                  <SummaryChip label="Total" value={g.summary.total} color="#94A3B8" />
                  <SummaryChip label="Pending AI" value={g.summary.pending} color="#F5C842" />
                  <SummaryChip label="Done" value={g.summary.done} color="#22C55E" />
                  <SummaryChip label="Failed" value={g.summary.failed} color="#F87171" />
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
                      {m.media_type === 'photo' ? (
                        <img src={m.gcs_url} alt={m.file_name || 'capture'}
                          style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }} />
                      ) : (
                        <div style={{ width: '100%', height: 110, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontSize: 26, background: '#0a0c11' }}>
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
  draft:             { label: 'Draft',             color: '#94A3B8' },
  capturing:         { label: 'Capturing',         color: '#F5C842' },
  ready_to_complete: { label: 'Ready to complete', color: '#6366F1' },
  completed:         { label: 'Completed',         color: '#22C55E' },
  ai_processing:     { label: 'AI analysing…',     color: '#F5C842' },
  ai_completed:      { label: 'AI complete',       color: '#22C55E' },
}

const UPLOAD_STATUS_META = {
  pending:   { label: 'Pending AI', color: '#F5C842' },
  analysing: { label: 'Analysing',  color: '#818CF8' },
  done:      { label: 'Done',       color: '#22C55E' },
  failed:    { label: 'Failed',     color: '#F87171' },
}

function WalkthroughBadge({ status }) {
  const meta = WT_STATUS_META[status] || { label: status, color: '#94A3B8' }
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: meta.color,
      border: `1px solid ${meta.color}33`, background: 'var(--bg-hover)',
      borderRadius: 20, padding: '2px 8px' }}>
      {meta.label}
    </span>
  )
}

function UploadStatusBadge({ status }) {
  const meta = UPLOAD_STATUS_META[status] || { label: status, color: '#94A3B8' }
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
