import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Sidebar from './components/Sidebar'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import FloorView from './pages/FloorView'
import Upload from './pages/Upload'
import AnalysisPage from './pages/Analysis'
import Projects from './pages/Projects'
import { ProjectProvider } from './hooks/useProject'
import PanoramaViewer from './pages/PanoramaViewer'
import { SiteProvider } from './hooks/SiteContext'
import SiteSetup   from './pages/SiteSetup'
import SiteCapture from './pages/SiteCapture'

function Layout({ children }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  )
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="flex items-center justify-center h-screen text-sm text-gray-400">Loading...</div>
  if (!user) return <Navigate to="/login" replace />
  return (
    <ProjectProvider>          {/* ← wrap karo */}
     <SiteProvider>          {/* ← add karo */}
        <Layout>{children}</Layout>
      </SiteProvider>
       </ProjectProvider>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/floors" element={<ProtectedRoute><FloorView /></ProtectedRoute>} />
      <Route path="/upload" element={<ProtectedRoute><Upload /></ProtectedRoute>} />
      <Route path="/analysis" element={<ProtectedRoute><AnalysisPage /></ProtectedRoute>} />
      <Route path="/panorama" element={<ProtectedRoute><PanoramaViewer /></ProtectedRoute>} />
      <Route path="/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
      <Route path="/site-setup"   element={<ProtectedRoute><SiteSetup /></ProtectedRoute>} />
      <Route path="/site-capture" element={<ProtectedRoute><SiteCapture /></ProtectedRoute>} />
      
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
        <Toaster position="top-right" toastOptions={{ style: { fontSize: '13px' } }} />
      </BrowserRouter>
    </AuthProvider>
  )
}