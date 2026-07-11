import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { createProject, getFloors, addFloor, getUnits, addUnit, getRooms, addRoom } from '../utils/api'
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
  const { projects, addProject } = useProject()
  const [floors, setFloors] = useState([])
  const [units, setUnits] = useState([])
  const [rooms, setRooms] = useState([])
  const [sel, setSel] = useState({ project: null, floor: null, unit: null })
  const [newProj, setNewProj] = useState({ name: '', location: '', total_floors: 5, planned_completion: '' })

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
          selected={sel.project} onSelect={id => setSel({ project: id, floor: null, unit: null })}
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
    </div>
    </div>
    )
}
