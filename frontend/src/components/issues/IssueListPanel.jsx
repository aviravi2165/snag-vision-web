/**
 * IssueListPanel — search + status filters over the issues at this location.
 * Filtering is client-side because the set is already scoped to one spot and
 * is small; this keeps the list instant as you type.
 */
import { useMemo, useState } from 'react'
import { Empty } from '../UI'
import { IssueStatusBadge, IssuePriorityBadge, STATUSES, STATUS_LABEL, formatDate, Avatar } from './IssueBits'

export default function IssueListPanel({ issues, loading, currentUploadId, onSelect }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return issues.filter(i => {
      if (status !== 'all' && i.status !== status) return false
      if (!q) return true
      return (
        i.title.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.tags || []).some(t => t.includes(q))
      )
    })
  }, [issues, query, status])

  const counts = useMemo(() => {
    const c = { all: issues.length }
    STATUSES.forEach(s => { c[s] = issues.filter(i => i.status === s).length })
    return c
  }, [issues])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input placeholder="Search issues…" value={query} onChange={e => setQuery(e.target.value)} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {['all', ...STATUSES].map(s => (
          <button key={s} onClick={() => setStatus(s)} style={{
            fontSize: 11, padding: '4px 9px', borderRadius: 20, cursor: 'pointer',
            background: status === s ? 'var(--charcoal)' : 'var(--bg-surface)',
            border: `1px solid ${status === s ? 'var(--charcoal)' : 'var(--border)'}`,
            color: status === s ? '#fff' : 'var(--text-3)',
          }}>
            {s === 'all' ? 'All' : STATUS_LABEL[s]} ({counts[s] || 0})
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <Empty
          message={issues.length ? 'No issues match this filter' : 'No issues at this location yet'}
          hint={issues.length ? undefined : 'Use "Mark Issue" to raise the first one'}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(i => {
            // Markers persist across capture dates, so make it obvious when an
            // issue was raised on a *different* capture than the one on screen.
            const raisedElsewhere =
              i.marker?.origin_upload_id && currentUploadId &&
              i.marker.origin_upload_id !== currentUploadId
            return (
              <button key={i.id} onClick={() => onSelect(i)} style={{
                textAlign: 'left', cursor: 'pointer', padding: '10px 12px',
                borderRadius: 10, border: '1px solid var(--border)',
                background: 'var(--bg-surface)', display: 'flex',
                flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <IssueStatusBadge status={i.status} />
                  <IssuePriorityBadge priority={i.priority} />
                  {raisedElsewhere && (
                    <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                      · raised {formatDate(i.marker.origin_captured_at)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{i.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-3)' }}>
                  <span>Due {formatDate(i.due_date)}</span>
                  {i.assignees?.length > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 'auto' }}>
                      {i.assignees.slice(0, 3).map(a => <Avatar key={a.id} name={a.name} size={16} />)}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
