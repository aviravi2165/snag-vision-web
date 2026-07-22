import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import {
  createProject, getFloors, addFloor, getUnits, addUnit, getRooms, addRoom,
  getActivities, setActivities as saveActivities,
} from '../utils/api'
import { useProject } from '../hooks/useProject'

const Col = ({ title, items, selected, onSelect, onAdd, addLabel, addPlaceholder, type = 'text' }) => {
  const [val, setVal] = useState('')
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13 }}>{title}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type={type} placeholder={addPlaceholder} value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && val) { onAdd(val); setVal('') } }}
          style={{ flex: 1 }} />
        <button className="btn-ghost" style={{ whiteSpace: 'nowrap', padding: '8px 12px' }}
          onClick={() => { if (val) { onAdd(val); setVal('') } }}>+ Add</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>None yet</div>
        ) : items.map(item => (
          <button key={item.id} onClick={() => onSelect(item.id)} style={{
            background: selected === item.id ? 'var(--amber-glow)' : 'transparent',
            border: `1px solid ${selected === item.id ? 'var(--amber-dim)' : 'transparent'}`,
            color: selected === item.id ? 'var(--amber)' : 'var(--text-2)',
            borderRadius: 8, padding: '8px 12px', cursor: 'pointer',
            fontSize: 13, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            transition: 'all .15s',
          }}>
            <span>{item.label}</span>
            {item.sub !== undefined && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{Math.round(item.sub)}%</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function Projects() {
  const { projects, addProject, switchProject } = useProject()
  const [floors, setFloors] = useState([])
  const [units, setUnits] = useState([])
  const [rooms, setRooms] = useState([])
  const [sel, setSel] = useState({ project: null, floor: null, unit: null })
  const [newProj, setNewProj] = useState({ name: '', location: '', total_floors: 5, planned_completion: '' })

  // ── Activity Plan (drives the Executive dashboard + AI prompt categories) ──
  // Each entry is { name, target_date } — target_date (YYYY-MM-DD or null) is
  // the planned completion date, used to compute planned-vs-actual / delay.
  const [activities,    setActivitiesState] = useState([])
  const [newActivity,   setNewActivity]     = useState('')
  const [newTargetDate, setNewTargetDate]   = useState('')
  const [savingPlan,    setSavingPlan]      = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!sel.project) { setActivitiesState([]); return }
    getActivities(sel.project)
      // Older projects may still return plain name strings — normalize.
      .then(({ data }) => setActivitiesState(
        data.map(a => (typeof a === 'string' ? { name: a, target_date: null } : a))
      ))
      .catch(() => setActivitiesState([]))
  }, [sel.project])

  const addActivity = () => {
    const name = newActivity.trim()
    if (!name) return
    if (activities.some(a => a.name.toLowerCase() === name.toLowerCase())) { toast.error('Already added'); return }
    setActivitiesState(prev => [...prev, { name, target_date: newTargetDate || null }])
    setNewActivity('')
    setNewTargetDate('')
  }
  const removeActivity = (name) => setActivitiesState(prev => prev.filter(a => a.name !== name))

  // Excel date serials/Date objects -> 'YYYY-MM-DD'
  const toIsoDate = (raw) => {
    if (!raw) return null
    const d = raw instanceof Date ? raw : new Date(raw)
    return isNaN(d) ? null : d.toISOString().slice(0, 10)
  }

  const handleExcelUpload = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(evt.target.result, { type: 'array', cellDates: true })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' })

        let parsed = []
        if (json.length && typeof json[0] === 'object') {
          // Sheet has headers — find the activity-name column and an optional
          // target-date column (Target Date / Deadline / Completion Date / etc.)
          const keys = Object.keys(json[0])
          const isNumericColumn = (k) => json.every(row => {
            const v = row[k]
            return v === '' || v === null || v === undefined || (!isNaN(Number(v)) && !(v instanceof Date))
          })
          const dateKey = keys.find(k => /date|deadline|target|completion|due/i.test(k))
          // Name column: prefer an explicitly-labelled, non-numeric column (skips
          // serial-number columns like "S.No" / "#" that would otherwise get
          // picked up as the "name"); fall back to the first non-numeric,
          // non-date column in the sheet.
          const nameKey =
            keys.find(k => /activity|task|item|scope|description|work/i.test(k) && !isNumericColumn(k)) ||
            keys.find(k => k !== dateKey && !isNumericColumn(k)) ||
            keys[0]
          parsed = json.map(row => ({
            name: String(row[nameKey] ?? '').trim(),
            target_date: dateKey ? toIsoDate(row[dateKey]) : null,
          }))
        }
        parsed = parsed.filter(r => r.name && !/^activity(\s*(name|plan))?$/i.test(r.name))

        const unique = []
        for (const r of parsed) {
          if (!unique.some(u => u.name.toLowerCase() === r.name.toLowerCase())) unique.push(r)
        }
        if (unique.length === 0) { toast.error('No activity names found in file'); return }
        setActivitiesState(prev => {
          const merged = [...prev]
          for (const r of unique) {
            if (!merged.some(m => m.name.toLowerCase() === r.name.toLowerCase())) merged.push(r)
          }
          return merged
        })
        toast.success(`${unique.length} activities imported`)
      } catch {
        toast.error('Could not read this file — check it is a valid .xlsx/.csv')
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleSavePlan = async () => {
    if (!sel.project) { toast.error('Select a project first'); return }
    setSavingPlan(true)
    try {
      await saveActivities(sel.project, activities)
      toast.success('Activity Plan saved')
    } catch {
      toast.error('Failed to save Activity Plan')
    } finally {
      setSavingPlan(false)
    }
  }

  useEffect(() => {
    if (!sel.project) return
    getFloors(sel.project).then(({ data }) => { setFloors(data); setSel(s => ({ ...s, floor: null, unit: null })); setUnits([]); setRooms([]) })
  }, [sel.project])
  useEffect(() => {
    if (!sel.floor) return
    getUnits(sel.floor).then(({ data }) => { setUnits(data); setSel(s => ({ ...s, unit: null })); setRooms([]) })
  }, [sel.floor])
  useEffect(() => {
    if (!sel.unit) return
    getRooms(sel.unit).then(({ data }) => setRooms(data))
  }, [sel.unit])

  const handleCreate = async () => {
    if (!newProj.name) return
    const payload = {
    ...newProj,
    total_floors: Number(newProj.total_floors),
    planned_completion: newProj.planned_completion
      ? new Date(newProj.planned_completion).toISOString()
      : null,
  }
  const { data } = await createProject(payload)
  addProject(data)
  toast.success('Project created')
  setNewProj({ name: '', location: '', total_floors: 5, planned_completion: '' })
}

  return (
    <div style={{ padding: 28, maxWidth: 1000 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontFamily: 'Space Grotesk', fontWeight: 700, marginBottom: 4 }}>Project setup</h1>
        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>Configure project hierarchy before uploading media.</p>
      </div>

      {/* Create project */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 14 }}>New project</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 130px auto', gap: 10, alignItems: 'end' }}>
          <div>
            <label className="label">Project name</label>
            <input placeholder="Skyline Residency" value={newProj.name} onChange={e => setNewProj({ ...newProj, name: e.target.value })} />
        </div>
        <div>
          <label className="label">Location</label>
          <input placeholder="Udaipur" value={newProj.location} onChange={e => setNewProj({ ...newProj, location: e.target.value })} />
        </div>
        <div>
          <label className="label">Floors</label>
          <input type="number" value={newProj.total_floors} onChange={e => setNewProj({ ...newProj, total_floors: e.target.value })} />
        </div>
        <div>
          <label className="label">Target date</label>
          <input type="date" value={newProj.planned_completion}
            onChange={e => setNewProj({ ...newProj, planned_completion: e.target.value })} />
        </div>
        <button className="btn-primary" onClick={handleCreate} style={{ alignSelf: 'flex-end' }}>Create project</button>
      </div>

      {/* Hierarchy columns */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Col title="Projects" addPlaceholder="Project name" type="text"
          items={projects.map(p => ({ id: p.id, label: p.name, sub: undefined }))}
          selected={sel.project}
          onSelect={id => { setSel({ project: id, floor: null, unit: null }); switchProject(id) }}
          onAdd={name => { createProject({ name, total_floors: 5 }).then(({ data }) => { addProject(data); toast.success('Project created') }) }} />

        <Col title="Floors" addPlaceholder="Floor number" type="number"
          items={floors.map(f => ({ id: f.id, label: `Floor ${f.floor_number}`, sub: f.progress_pct }))}
          selected={sel.floor} onSelect={id => setSel(s => ({ ...s, floor: id, unit: null }))}
          onAdd={n => {
            if (!sel.project) { toast.error('Select a project first'); return }
            addFloor(sel.project, { floor_number: Number(n) }).then(({ data }) => setFloors(f => [...f, data]))
          }} />

        <Col title="Units" addPlaceholder="Unit (e.g. A-204)"
          items={units.map(u => ({ id: u.id, label: u.unit_number, sub: u.progress_pct }))}
          selected={sel.unit} onSelect={id => setSel(s => ({ ...s, unit: id }))}
          onAdd={n => {
            if (!sel.floor) { toast.error('Select a floor first'); return }
            addUnit(sel.floor, { unit_number: n }).then(({ data }) => setUnits(u => [...u, data]))
          }} />

        <Col title="Rooms" addPlaceholder="Room name"
          items={rooms.map(r => ({ id: r.id, label: r.name, sub: r.progress_pct }))}
          selected={null} onSelect={() => {}}
          onAdd={n => {
            if (!sel.unit) { toast.error('Select a unit first'); return }
            addRoom(sel.unit, { name: n }).then(({ data }) => setRooms(r => [...r, data])).then(() => toast.success('Room added'))
          }} />
      </div>

      {/* Activity Plan — feeds both the Executive dashboard and the Gemini prompt */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          Activity Plan
        </div>
        {!sel.project ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>
            Select a project above to define its activities.
          </div>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
              Upload an Excel/CSV file listing the activities to track for this project, with an activity
              name column (e.g. Commercial Tiles, Wall Panelling) and a target/planned completion date
              column. AI analysis scores each activity's actual completion %, and the target date lets
              the Executive dashboard show planned-vs-actual progress and flag delays.
            </p>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
              onChange={handleExcelUpload} style={{ display: 'none' }} />
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn-primary" style={{ whiteSpace: 'nowrap' }}
                onClick={() => fileInputRef.current?.click()}>⬆ Upload Excel/CSV</button>
              <input placeholder="…or add one manually" value={newActivity}
                onChange={e => setNewActivity(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addActivity() }}
                style={{ flex: 1 }} />
              <input type="date" value={newTargetDate} title="Target completion date (optional)"
                onChange={e => setNewTargetDate(e.target.value)} style={{ width: 150 }} />
              <button className="btn-ghost" style={{ whiteSpace: 'nowrap', padding: '8px 12px' }}
                onClick={addActivity}>+ Add</button>
            </div>
            {activities.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
                No activities yet — none added means AI falls back to the default furniture-category list.
              </div>
            ) : (
              <details style={{ marginBottom: 14 }}>
                <summary style={{ fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span>✓ {activities.length} {activities.length === 1 ? 'activity' : 'activities'} loaded — click to review</span>
                  <button onClick={(e) => { e.preventDefault(); setActivitiesState([]) }} style={{
                    background: 'none', border: 'none', cursor: 'pointer', color: '#C62828',
                    fontSize: 11, textDecoration: 'underline', padding: 0,
                  }}>Remove all</button>
                </summary>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10,
                  maxHeight: 220, overflowY: 'auto' }}>
                  {activities.map(a => (
                    <span key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6,
                      background: 'var(--amber-glow)', border: '1px solid var(--amber-dim)',
                      borderRadius: 20, padding: '5px 8px 5px 12px', fontSize: 12, color: 'var(--amber)' }}>
                      {a.name}
                      {a.target_date && (
                        <span style={{ fontSize: 10, opacity: 0.8 }}>
                          · target {new Date(a.target_date + 'T00:00:00').toLocaleDateString()}
                        </span>
                      )}
                      <button onClick={() => removeActivity(a.name)} style={{
                        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--amber)',
                        fontSize: 13, lineHeight: 1, padding: 0,
                      }}>×</button>
                    </span>
                  ))}
                </div>
              </details>
            )}
            <button className="btn-primary" onClick={handleSavePlan} disabled={savingPlan}>
              {savingPlan ? 'Saving…' : 'Save Activity Plan'}
            </button>
          </>
        )}
      </div>
    </div>
    </div>
    )
}
