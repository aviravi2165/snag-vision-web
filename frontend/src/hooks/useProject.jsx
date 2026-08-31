import { createContext, useContext, useState, useEffect } from 'react'
import { getProjects } from '../utils/api'

const ProjectCtx = createContext(null)

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getProjects().then(({ data }) => {
      setProjects(data)

      // localStorage se last selected project restore karo
      const savedId = localStorage.getItem('siteiq_project_id')
      const found = data.find(p => p.id === savedId)

      // saved mila toh woh, warna pehla project
      setSelectedProject(found || data[0] || null)
    }).finally(() => setLoading(false))
  }, [])

  const switchProject = (projectId) => {
    const p = projects.find(p => p.id === projectId)
    if (!p) return
    setSelectedProject(p)
    localStorage.setItem('siteiq_project_id', projectId)
  }

  // Called after a project is created elsewhere (Projects page) so the sidebar's
  // "Active project" dropdown and every other consumer of this context updates immediately.
  const addProject = (project) => {
    setProjects(prev => [...prev, project])
    setSelectedProject(project)
    localStorage.setItem('siteiq_project_id', project.id)
  }

  // Called after a project is deleted (Layout Setup's Projects column) — drops
  // it from every consumer of this context, and if it was the active
  // project, falls back to whatever's left (or null if this was the last one).
  const removeProject = (projectId) => {
    setProjects(prev => {
      const next = prev.filter(p => p.id !== projectId)
      setSelectedProject(current => {
        if (current?.id !== projectId) return current
        const fallback = next[0] || null
        if (fallback) localStorage.setItem('siteiq_project_id', fallback.id)
        else localStorage.removeItem('siteiq_project_id')
        return fallback
      })
      return next
    })
  }

  return (
    <ProjectCtx.Provider value={{ projects, selectedProject, switchProject, addProject, removeProject, loading }}>
      {children}
    </ProjectCtx.Provider>
  )
}

export const useProject = () => useContext(ProjectCtx)