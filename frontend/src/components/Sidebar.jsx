import { NavLink } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useProject } from '../hooks/useProject'

const links = [
  { to: '/dashboard', icon: '▦',  label: 'Executive'    },
  { to: '/floors',    icon: '⊟',  label: 'Floor view'   },
  { to: '/analysis',  icon: '◈',  label: 'AI analysis'  },
  { to: '/upload',    icon: '↑',   label: 'Upload'       },
  { to: '/panorama',  icon: '🔭',  label: 'Panorama'     },
  { to: '/site-capture', icon: '📸', label: 'Site Capture' },
  { to: '/site-setup',   icon: '📐', label: 'Layout Setup' },
  { to: '/projects',  icon: '⚙',  label: 'Projects'     },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { projects, selectedProject, switchProject } = useProject()

  return (
    <aside style={{
      width: 212, flexShrink: 0,
      background: '#FFFFFF',
      borderRight: '1px solid #E5E5E5',
      display: 'flex', flexDirection: 'column',
      minHeight: '100vh', position: 'sticky', top: 0,
    }}>
      {/* Brand */}
      <div style={{
        padding: '18px 16px 14px',
        borderBottom: '1px solid #EBEAE6',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: '#D32F2F',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, fontWeight: 800, color: '#FFFFFF',
          fontFamily: 'Space Grotesk, sans-serif',
        }}>S</div>
        <div>
          <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700,
            fontSize: 15, color: '#111111', letterSpacing: '-0.03em' }}>
            SiteIQ
          </div>
          <div style={{ fontSize: 10, color: '#999999', letterSpacing: '.05em',
            textTransform: 'uppercase' }}>
            by IEVO
          </div>
        </div>
      </div>

      {/* Project Switcher */}
      {projects?.length > 0 && (
        <div style={{ padding: '10px 12px 0' }}>
          <div style={{ fontSize: 10, color: '#999999', letterSpacing: '.08em',
            textTransform: 'uppercase', marginBottom: 6, paddingLeft: 4 }}>
            Active project
          </div>
          <select
            value={selectedProject?.id || ''}
            onChange={e => switchProject(e.target.value)}
            style={{
              width: '100%', background: '#F8F7F4',
              border: '1px solid #E5E5E5', borderRadius: 8,
              padding: '7px 10px', fontSize: 12,
              color: '#111111', cursor: 'pointer',
            }}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: '10px 10px', overflowY: 'auto' }}>
        <div style={{ fontSize: 10, color: '#999999', letterSpacing: '.08em',
          textTransform: 'uppercase', padding: '8px 8px 4px', marginBottom: 2 }}>
          Monitor
        </div>
        {links.slice(0, 2).map(l => (
          <NavLink key={l.to} to={l.to}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span style={{ fontFamily: 'monospace', width: 16 }}>{l.icon}</span>
            {l.label}
          </NavLink>
        ))}

        <div style={{ fontSize: 10, color: '#999999', letterSpacing: '.08em',
          textTransform: 'uppercase', padding: '12px 8px 4px', marginBottom: 2 }}>
          Manage
        </div>
        {links.slice(2).map(l => (
          <NavLink key={l.to} to={l.to}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span style={{ fontFamily: 'monospace', width: 16 }}>{l.icon}</span>
            {l.label}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      <div style={{ padding: '10px 10px 14px', borderTop: '1px solid #EBEAE6' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 10px', background: '#F8F7F4', borderRadius: 8, marginBottom: 4 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: '#FFEBEE', border: '1.5px solid #FFCDD2',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: '#D32F2F',
            fontFamily: 'Space Grotesk, sans-serif',
          }}>
            {user?.name?.charAt(0) || 'U'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#111111',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.name}
            </div>
            <div style={{ fontSize: 10, color: '#999999', textTransform: 'capitalize' }}>
              {user?.role?.replace('_', ' ')}
            </div>
          </div>
        </div>
        <button onClick={logout} style={{
          background: 'none', border: 'none', color: '#999999',
          fontSize: 12, cursor: 'pointer', padding: '3px 10px',
          width: '100%', textAlign: 'left', transition: 'color .15s',
        }}
          onMouseOver={e => e.target.style.color = '#D32F2F'}
          onMouseOut={e => e.target.style.color = '#999999'}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}