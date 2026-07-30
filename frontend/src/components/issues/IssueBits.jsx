/**
 * Small shared pieces used by the issue form / list / details panels.
 * Kept together so the three panels stay presentational and consistent, and
 * so status/priority styling is defined exactly once.
 */
import { useState } from 'react'

export const STATUSES = ['open', 'in_progress', 'resolved', 'closed']

export const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

// Reuses the app's existing .badge classes (see index.css) so issues look like
// every other status chip in the product.
const STATUS_BADGE_CLASS = {
  open: 'badge badge-red',
  in_progress: 'badge badge-amber',
  resolved: 'badge badge-green',
  closed: 'badge badge-blue',
}
const PRIORITY_BADGE_CLASS = {
  high: 'badge badge-red',
  medium: 'badge badge-amber',
  low: 'badge badge-blue',
}

export function IssueStatusBadge({ status }) {
  return <span className={STATUS_BADGE_CLASS[status] || 'badge'}>{STATUS_LABEL[status] || status}</span>
}

export function IssuePriorityBadge({ priority }) {
  return (
    <span className={PRIORITY_BADGE_CLASS[priority] || 'badge'}>
      {(priority || '').toUpperCase()}
    </span>
  )
}

export function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/** Type-to-search-or-create tag input. `suggestions` is the project's existing vocabulary. */
export function TagInput({ value = [], suggestions = [], onChange }) {
  const [text, setText] = useState('')
  const add = (tag) => {
    const t = tag.trim().toLowerCase()
    if (!t || value.includes(t)) { setText(''); return }
    onChange([...value, t])
    setText('')
  }
  const matches = text
    ? suggestions.filter(s => s.includes(text.toLowerCase()) && !value.includes(s)).slice(0, 5)
    : []

  return (
    <div>
      <input
        placeholder="Type to search or create tags"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); add(text) }
          if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
      />
      {matches.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {matches.map(s => (
            <button key={s} type="button" onClick={() => add(s)} style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 20, cursor: 'pointer',
              background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-2)',
            }}>+ {s}</button>
          ))}
        </div>
      )}
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {value.map(t => (
            <span key={t} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, padding: '3px 8px', borderRadius: 20,
              background: 'var(--amber-glow)', border: '1px solid var(--amber-dim)', color: 'var(--amber)',
            }}>
              {t}
              <button type="button" onClick={() => onChange(value.filter(x => x !== t))} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--amber)', fontSize: 12, lineHeight: 1, padding: 0,
              }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Multi-select user picker backed by GET /auth/users. */
export function AssigneePicker({ value = [], users = [], onChange }) {
  const toggle = (id) =>
    onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id])

  if (!users.length) {
    return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No users available</div>
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {users.map(u => {
        const on = value.includes(u.id)
        return (
          <button key={u.id} type="button" onClick={() => toggle(u.id)} title={u.email} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 11, padding: '4px 9px', borderRadius: 20, cursor: 'pointer',
            background: on ? 'var(--amber-glow)' : 'var(--bg-hover)',
            border: `1px solid ${on ? 'var(--amber-dim)' : 'var(--border)'}`,
            color: on ? 'var(--amber)' : 'var(--text-2)',
          }}>
            <Avatar name={u.name} />
            {u.name}
          </button>
        )
      })}
    </div>
  )
}

export function Avatar({ name, size = 18 }) {
  const initials = (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: 'var(--accent-light)', color: 'var(--accent)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.45, fontWeight: 700,
    }}>{initials}</span>
  )
}
