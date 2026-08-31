import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import {
  createProject, deleteProject, getFloors, addFloor, getUnits, addUnit, getRooms, addRoom,
  getActivities, setActivities as saveActivities,
  uploadActivityExcel, updateUnitMap,
} from '../utils/api'
import { useProject } from '../hooks/useProject'

const Col = ({ title, items, selected, onSelect, onAdd, addLabel, addPlaceholder, type = 'text', onDeleteItem }) => {
  const [val, setVal] = useState('')
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 13 }}>{title}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type={type} placeholder={addPlaceholder} value={val} min={type === 'number' ? 1 : undefined}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && val && (type !== 'number' || Number(val) > 0)) { onAdd(val); setVal('') } }}
          style={{ flex: 1 }} />
        <button className="btn-ghost" style={{ whiteSpace: 'nowrap', padding: '8px 12px' }}
          onClick={() => { if (val && (type !== 'number' || Number(val) > 0)) { onAdd(val); setVal('') } }}>+ Add</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>None yet</div>
        ) : items.map(item => (
          <div key={item.id} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: selected === item.id ? 'var(--amber-glow)' : 'transparent',
            border: `1px solid ${selected === item.id ? 'var(--amber-dim)' : 'transparent'}`,
            borderRadius: 8, transition: 'all .15s',
          }}>
            <button onClick={() => onSelect(item.id)} style={{
              flex: 1, background: 'transparent', border: 'none',
              color: selected === item.id ? 'var(--amber)' : 'var(--text-2)',
              padding: '8px 12px', cursor: 'pointer',
              fontSize: 13, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>{item.label}</span>
              {item.sub !== undefined && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{Math.round(item.sub)}%</span>}
            </button>
            {onDeleteItem && (
              <button onClick={() => onDeleteItem(item)} title={`Delete ${item.label}`} style={{
                background: 'transparent', border: 'none', color: 'var(--text-3)',
                cursor: 'pointer', fontSize: 14, padding: '8px 10px', lineHeight: 1,
              }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger-text)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-3)' }}>
                🗑
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Projects() {
  const { projects, addProject, removeProject, switchProject } = useProject()
  const [floors, setFloors] = useState([])
  const [units, setUnits] = useState([])
  const [rooms, setRooms] = useState([])
  const [sel, setSel] = useState({ project: null, floor: null, unit: null })
  const [newProj, setNewProj] = useState({ name: '', location: '' })

  // ── Activity Plan (drives the Executive dashboard + AI prompt categories) ──
  // Each entry is { name, target_date } — target_date (YYYY-MM-DD or null) is
  // the planned completion date, used to compute planned-vs-actual / delay.
  const [activities,    setActivitiesState] = useState([])
  const [newActivity,   setNewActivity]     = useState('')
  const [newTargetDate, setNewTargetDate]   = useState('')
  const [savingPlan,    setSavingPlan]      = useState(false)
  const [uploadingExcel, setUploadingExcel] = useState(false)
  // Excel columns are Units (e.g. "A-101") — the Activity Excel's "Room" grain.
  // Area-level (Living/Bathroom) breakdown stays Floor View's job; columns that
  // couldn't be auto-matched to a real Setup-phase Unit are surfaced here for a
  // manual link instead of a guess.
  const [unmatchedCols, setUnmatchedCols]   = useState([])
  const [unitLinks,     setUnitLinks]       = useState({})   // { col_index: unit_id }
  const [projectUnits,  setProjectUnits]    = useState([])   // all units in the project, for the link picker
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

  // All Units across the project's floors — used to build the "link this
  // Excel column to a Unit" picker for unmatched columns. No need to drill
  // into Areas (Room model) here — that's Floor View's concern, not this one.
  const fetchProjectUnits = async (projectId) => {
    const { data: projFloors } = await getFloors(projectId)
    const all = []
    for (const f of projFloors) {
      const { data: projUnits } = await getUnits(f.id)
      for (const u of projUnits) all.push({ id: u.id, label: `Floor ${f.floor_number} | ${u.unit_number}` })
    }
    return all
  }

  const handleExcelUpload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !sel.project) return
    setUploadingExcel(true)
    setUnmatchedCols([])
    setUnitLinks({})
    try {
      const { data } = await uploadActivityExcel(sel.project, file)
      setActivitiesState(data.activities)
      if (data.unmatched_columns?.length) {
        setUnmatchedCols(data.unmatched_columns)
        setProjectUnits(await fetchProjectUnits(sel.project))
        toast(`${data.activities.length} activities loaded — ${data.unmatched_columns.length} room column(s) need manual linking`, { icon: '⚠️' })
      } else {
        toast.success(`${data.activities.length} activities loaded, ${data.matched_rooms} room columns matched`)
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not process this Excel file')
    } finally {
      setUploadingExcel(false)
    }
  }

  const handleSaveUnitLinks = async () => {
    const links = Object.entries(unitLinks)
      .filter(([, unitId]) => unitId)
      .map(([colIndex, unitId]) => ({ unit_id: unitId, col_index: Number(colIndex) }))
    if (!links.length) { toast.error('Pick a room for at least one column'); return }
    try {
      await updateUnitMap(sel.project, links)
      setUnmatchedCols(prev => prev.filter(c => !unitLinks[c.col_index]))
      toast.success('Room links saved')
    } catch {
      toast.error('Failed to save room links')
    }
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
    // Floor count and completion date used to be asked here too, but floors
    // are added one at a time in the Floors column right below, and the
    // Activity Plan section further down already carries its own (more
    // useful, per-activity) target dates — asking for a single project-wide
    // guess of either up front was redundant with both.
    const payload = { ...newProj, total_floors: 1, planned_completion: null }
    const { data } = await createProject(payload)
    addProject(data)
    toast.success('Project created')
    setNewProj({ name: '', location: '' })
  }

  const handleDeleteProject = async (project) => {
    if (!window.confirm(
      `Delete "${project.label}"? This permanently removes every floor, unit, room, photo, ` +
      `walkthrough and issue under it. This cannot be undone.`
    )) return
    try {
      await deleteProject(project.id)
      removeProject(project.id)
      // Only reset the hierarchy picker if the project being browsed is the
      // one that just got deleted — deleting a different project shouldn't
      // knock the user out of what they're currently looking at.
      setSel(s => s.project === project.id ? { project: null, floor: null, unit: null } : s)
      toast.success('Project deleted')
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to delete project')
    }
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
          <div>
            <label className="label">Project name</label>
            <input placeholder="Skyline Residency" value={newProj.name} onChange={e => setNewProj({ ...newProj, name: e.target.value })} />
        </div>
        <div>
          <label className="label">Location</label>
          <input placeholder="Udaipur" value={newProj.location} onChange={e => setNewProj({ ...newProj, location: e.target.value })} />
        </div>
        <button className="btn-primary" onClick={handleCreate} style={{ alignSelf: 'flex-end' }}>Create project</button>
      </div>

      {/* Hierarchy columns */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Col title="Projects" addPlaceholder="Project name" type="text"
          items={projects.map(p => ({ id: p.id, label: p.name, sub: undefined }))}
          selected={sel.project}
          onSelect={id => { setSel({ project: id, floor: null, unit: null }); switchProject(id) }}
          onAdd={name => { createProject({ name, total_floors: 1 }).then(({ data }) => { addProject(data); toast.success('Project created') }) }}
          onDeleteItem={handleDeleteProject} />

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
              Upload the project's Activity Excel — an activity name column, optional start/end date
              columns, and one column per Room (e.g. "A-101" — a Unit as a whole, combining all its
              Areas). It becomes the project's master progress sheet: AI analysis scores each activity's
              actual completion % per Room, and this exact file is kept in sync in place (formulas,
              formatting, and other sheets untouched) as new analyses land. Per-Area (e.g. Living Room /
              Bathroom) breakdown stays on the Floor View page, unaffected by this.
            </p>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls"
              onChange={handleExcelUpload} style={{ display: 'none' }} />
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn-primary" style={{ whiteSpace: 'nowrap' }}
                onClick={() => fileInputRef.current?.click()} disabled={uploadingExcel}>
                {uploadingExcel ? 'Uploading…' : '⬆ Upload Activity Excel'}
              </button>
              <input placeholder="…or add one manually" value={newActivity}
                onChange={e => setNewActivity(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addActivity() }}
                style={{ flex: 1 }} />
              <input type="date" value={newTargetDate} title="Target completion date (optional)"
                onChange={e => setNewTargetDate(e.target.value)} style={{ width: 150 }} />
              <button className="btn-ghost" style={{ whiteSpace: 'nowrap', padding: '8px 12px' }}
                onClick={addActivity}>+ Add</button>
            </div>
            {unmatchedCols.length > 0 && (
              <div style={{ background: 'var(--amber-glow)', border: '1px solid var(--amber-dim)',
                borderRadius: 8, padding: 12, marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                  ⚠ {unmatchedCols.length} room column{unmatchedCols.length === 1 ? '' : 's'} in the
                  Excel didn't match a Room (Unit) number exactly — link each to the right Room below.
                </div>
                {unmatchedCols.map(c => (
                  <div key={c.col_index} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, minWidth: 140 }}>"{c.header}"</span>
                    <select value={unitLinks[c.col_index] || ''} style={{ flex: 1 }}
                      onChange={e => setUnitLinks(prev => ({ ...prev, [c.col_index]: e.target.value }))}>
                      <option value="">— select room —</option>
                      {projectUnits.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
                    </select>
                  </div>
                ))}
                <button className="btn-ghost" style={{ marginTop: 4 }} onClick={handleSaveUnitLinks}>
                  Save room links
                </button>
              </div>
            )}
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
                    background: 'none', border: 'none', cursor: 'pointer', color: '#DC3A3A',
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
