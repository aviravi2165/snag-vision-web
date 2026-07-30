/**
 * IssueDetailsPanel — full issue record, status workflow and comment thread.
 * Status transitions are recorded server-side as `status_change` entries in the
 * same thread (see routers/issues.py), so this renders history and discussion
 * together as one audit trail.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import {
  IssueStatusBadge, IssuePriorityBadge, STATUSES, STATUS_LABEL, formatDate, Avatar,
} from './IssueBits'

export default function IssueDetailsPanel({
  issue, currentUploadId, onStatusChange, onDelete, loadComments, addComment, onBack,
}) {
  const [comments, setComments] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadComments(issue.id)
      .then(c => { if (!cancelled) setComments(c) })
      .catch(() => { if (!cancelled) setComments([]) })
    return () => { cancelled = true }
  }, [issue.id, issue.status, loadComments])

  const changeStatus = async (next) => {
    if (next === issue.status) return
    setBusy(true)
    try {
      await onStatusChange(issue.id, next)
    } catch {
      toast.error('Could not update status')
    } finally {
      setBusy(false)
    }
  }

  const postComment = async () => {
    const body = draft.trim()
    if (!body) return
    setBusy(true)
    try {
      const c = await addComment(issue.id, body)
      setComments(prev => [...prev, c])
      setDraft('')
    } catch {
      toast.error('Could not post comment')
    } finally {
      setBusy(false)
    }
  }

  const raisedElsewhere =
    issue.marker?.origin_upload_id && currentUploadId &&
    issue.marker.origin_upload_id !== currentUploadId

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button className="btn-ghost" onClick={onBack} style={{ alignSelf: 'flex-start', fontSize: 11, padding: '4px 10px' }}>
        ← All issues
      </button>

      <div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <IssueStatusBadge status={issue.status} />
          <IssuePriorityBadge priority={issue.priority} />
        </div>
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 16, color: 'var(--text-1)' }}>
          {issue.title}
        </div>
        {issue.description && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.6 }}>
            {issue.description}
          </div>
        )}
      </div>

      {raisedElsewhere && (
        <div style={{
          background: 'var(--info-bg)', border: '1px solid var(--info-border)',
          color: 'var(--info-text)', borderRadius: 8, padding: '8px 10px', fontSize: 11,
        }}>
          Raised on the {formatDate(issue.marker.origin_captured_at)} capture — you're viewing a different date.
        </div>
      )}

      {/* Status workflow: open → in progress → resolved → closed */}
      <div>
        <label className="label">Status</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {STATUSES.map(s => (
            <button key={s} disabled={busy} onClick={() => changeStatus(s)} style={{
              fontSize: 11, padding: '5px 10px', borderRadius: 20,
              cursor: s === issue.status ? 'default' : 'pointer',
              background: s === issue.status ? 'var(--charcoal)' : 'var(--bg-surface)',
              border: `1px solid ${s === issue.status ? 'var(--charcoal)' : 'var(--border)'}`,
              color: s === issue.status ? '#fff' : 'var(--text-2)',
              opacity: busy ? 0.6 : 1,
            }}>{STATUS_LABEL[s]}</button>
          ))}
        </div>
      </div>

      <Field label="Tags">
        {issue.tags?.length
          ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {issue.tags.map(t => (
                <span key={t} style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 20,
                  background: 'var(--amber-glow)', border: '1px solid var(--amber-dim)', color: 'var(--amber)',
                }}>{t}</span>
              ))}
            </div>
          )
          : <Muted>—</Muted>}
      </Field>

      <Field label="Assignees">
        {issue.assignees?.length
          ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {issue.assignees.map(a => (
                <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-2)' }}>
                  <Avatar name={a.name} /> {a.name}
                </span>
              ))}
            </div>
          )
          : <Muted>Unassigned</Muted>}
      </Field>

      <Field label="Due date"><Muted>{formatDate(issue.due_date)}</Muted></Field>
      <Field label="Created by"><Muted>{issue.created_by_user?.name || '—'}</Muted></Field>
      <Field label="Created"><Muted>{formatDate(issue.created_at)}</Muted></Field>
      {issue.resolved_at && (
        <Field label="Resolved"><Muted>{formatDate(issue.resolved_at)}</Muted></Field>
      )}

      {/* Activity — comments and status changes interleaved chronologically */}
      <div>
        <label className="label">Activity</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {comments.length === 0 && <Muted>No activity yet</Muted>}
          {comments.map(c => (
            <div key={c.id} style={{
              background: c.kind === 'status_change' ? 'var(--bg-hover)' : 'var(--bg-surface)',
              border: '1px solid var(--border-dim)', borderRadius: 8, padding: '8px 10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <Avatar name={c.author?.name} size={16} />
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
                  {c.author?.name || 'Someone'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-4)', marginLeft: 'auto' }}>
                  {formatDate(c.created_at)}
                </span>
              </div>
              <div style={{
                fontSize: 12, lineHeight: 1.5,
                color: c.kind === 'status_change' ? 'var(--text-3)' : 'var(--text-2)',
                fontStyle: c.kind === 'status_change' ? 'italic' : 'normal',
              }}>{c.body}</div>
            </div>
          ))}
        </div>
        <textarea rows={2} style={{ resize: 'none' }} placeholder="Add a comment…"
          value={draft} onChange={e => setDraft(e.target.value)} />
        <button className="btn-ghost" onClick={postComment} disabled={busy || !draft.trim()}
          style={{ marginTop: 6, width: '100%' }}>
          Comment
        </button>
      </div>

      <button className="btn-ghost" onClick={() => onDelete(issue.id)} disabled={busy}
        style={{ color: 'var(--danger-text)', borderColor: 'var(--danger-border)' }}>
        Delete issue
      </button>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  )
}

function Muted({ children }) {
  return <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{children}</span>
}
