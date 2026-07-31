/**
 * IssueFormPanel — the creation form shown after a marker is placed.
 * Presentational: it collects fields and hands them back; useIssues does the
 * saving. The pending marker is passed in only so it can be described here.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import { AssigneePicker } from './IssueBits'

const PRIORITIES = ['high', 'medium', 'low']

export default function IssueFormPanel({ users, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    title: '', description: '', priority: 'medium', due_date: '',
    assignee_ids: [],
  })
  const [saving, setSaving] = useState(false)

  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const submit = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return }
    setSaving(true)
    try {
      await onSubmit({
        ...form,
        title: form.title.trim(),
        description: form.description.trim() || null,
        // Send an explicit timestamp so the backend parses it as a datetime
        due_date: form.due_date ? new Date(form.due_date + 'T00:00:00').toISOString() : null,
      })
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save the issue')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label className="label">Title *</label>
        <input autoFocus placeholder="Short summary of the problem"
          value={form.title} onChange={e => set({ title: e.target.value })} />
      </div>

      <div>
        <label className="label">Description</label>
        <textarea rows={3} style={{ resize: 'none' }}
          placeholder="What exactly is wrong? Any context the assignee needs…"
          value={form.description} onChange={e => set({ description: e.target.value })} />
      </div>

      <div>
        <label className="label">Due date</label>
        <input type="date" value={form.due_date} onChange={e => set({ due_date: e.target.value })} />
      </div>

      <div>
        <label className="label">Assign users</label>
        <AssigneePicker value={form.assignee_ids} users={users}
          onChange={ids => set({ assignee_ids: ids })} />
      </div>

      <div>
        <label className="label">Priority *</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {PRIORITIES.map(p => (
            <button key={p} type="button" onClick={() => set({ priority: p })} style={{
              flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
              fontSize: 12, textTransform: 'capitalize',
              background: form.priority === p ? 'var(--accent)' : 'var(--bg-surface)',
              border: `1px solid ${form.priority === p ? 'var(--accent)' : 'var(--border)'}`,
              color: form.priority === p ? '#fff' : 'var(--text-2)',
            }}>{p}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn-primary" onClick={submit} disabled={saving} style={{ flex: 1 }}>
          {saving ? 'Saving…' : 'Submit'}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  )
}
