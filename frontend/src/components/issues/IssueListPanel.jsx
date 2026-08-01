/**
 * IssueListPanel — project-wide issue list, the central place to browse and
 * navigate to any issue regardless of the viewer's currently selected
 * Floor/Room/Spot/Date. Filtering (status/priority/assignee/floor/room/search)
 * is client-side because `issues` is already the full per-project set fetched
 * once by useIssues — this keeps filtering instant as you type/toggle.
 *
 * Each row shows where the issue lives (Floor/Room/Spot + the date it was
 * raised) since the row's own location is very likely NOT the one currently
 * on screen — that's the whole point of a project-wide list. Selecting a row
 * hands the issue back to PanoramaViewer, which drives the cascade there.
 */
import { useMemo, useState } from 'react'
import { Empty } from '../UI'
import { IssueStatusBadge, IssuePriorityBadge, STATUSES, STATUS_LABEL, formatDate, Avatar } from './IssueBits'

const PRIORITIES = ['high', 'medium', 'low']

export default function IssueListPanel({ issues, loading, users = [], currentLocationId, onSelect }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [priority, setPriority] = useState('all')
  const [assigneeId, setAssigneeId] = useState('all')
  const [floorNumber, setFloorNumber] = useState('all')
  const [roomLabel, setRoomLabel] = useState('all')

  // Filter option vocabularies derived from the issues themselves — no extra
  // fetch needed, and options only ever list values that actually occur.
  const floorOptions = useMemo(() => {
    const set = new Set()
    issues.forEach(i => { if (i.marker?.floor_number != null) set.add(i.marker.floor_number) })
    return [...set].sort((a, b) => a - b)
  }, [issues])

  const roomOptions = useMemo(() => {
    const set = new Set()
    issues.forEach(i => { if (i.marker?.parent_label) set.add(i.marker.parent_label) })
    return [...set].sort()
  }, [issues])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return issues.filter(i => {
      if (status !== 'all' && i.status !== status) return false
      if (priority !== 'all' && i.priority !== priority) return false
      if (assigneeId !== 'all' && !(i.assignee_ids || []).includes(assigneeId)) return false
      if (floorNumber !== 'all' && i.marker?.floor_number !== Number(floorNumber)) return false
      if (roomLabel !== 'all' && i.marker?.parent_label !== roomLabel) return false
      if (!q) return true
      return (
        i.title.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q)
      )
    })
  }, [issues, query, status, priority, assigneeId, floorNumber, roomLabel])

  const counts = useMemo(() => {
    const c = { all: issues.length }
    STATUSES.forEach(s => { c[s] = issues.filter(i => i.status === s).length })
    return c
  }, [issues])

  const locationText = (m) => {
    if (!m) return null
    const parts = [
      m.floor_number != null ? `Floor ${m.floor_number}` : null,
      m.parent_label, m.location_label,
    ].filter(Boolean)
    return parts.join(' · ')
  }

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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FilterSelect label="Priority" value={priority} onChange={setPriority}
          options={[['all', 'Any priority'], ...PRIORITIES.map(p => [p, p[0].toUpperCase() + p.slice(1)])]} />
        <FilterSelect label="Assignee" value={assigneeId} onChange={setAssigneeId}
          options={[['all', 'Anyone'], ...users.map(u => [u.id, u.name])]} />
        <FilterSelect label="Floor" value={floorNumber} onChange={setFloorNumber}
          options={[['all', 'Any floor'], ...floorOptions.map(f => [String(f), `Floor ${f}`])]} />
        <FilterSelect label="Room" value={roomLabel} onChange={setRoomLabel}
          options={[['all', 'Any room'], ...roomOptions.map(r => [r, r])]} />
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <Empty
          message={issues.length ? 'No issues match this filter' : 'No issues in this project yet'}
          hint={issues.length ? undefined : 'Use "Mark Issue" on any photo to raise the first one'}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(i => {
            const here = i.marker?.location_id === currentLocationId
            return (
              <button key={i.id} onClick={() => onSelect(i)} style={{
                textAlign: 'left', cursor: 'pointer', padding: '10px 12px',
                borderRadius: 10, border: `1px solid ${here ? 'var(--amber-dim)' : 'var(--border)'}`,
                background: here ? 'var(--amber-glow)' : 'var(--bg-surface)',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <IssueStatusBadge status={i.status} />
                  <IssuePriorityBadge priority={i.priority} />
                  {here && (
                    <span style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 600 }}>· this spot</span>
                  )}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{i.title}</div>
                {i.marker && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    📍 {locationText(i.marker)}
                    {i.marker.origin_captured_at && ` · raised ${formatDate(i.marker.origin_captured_at)}`}
                  </div>
                )}
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

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="label">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </div>
  )
}
