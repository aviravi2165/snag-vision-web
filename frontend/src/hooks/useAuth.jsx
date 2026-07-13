import { createContext, useContext, useState, useEffect } from 'react'
import { login as apiLogin, register as apiRegister } from '../utils/api'

const AuthCtx = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem('siteiq_user')
    if (stored) setUser(JSON.parse(stored))
    setLoading(false)
  }, [])

  const login = async (email, password) => {
    const { data } = await apiLogin(email, password)
    localStorage.setItem('siteiq_token', data.access_token)
    localStorage.setItem('siteiq_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }

  const register = async (payload) => {
    const { data } = await apiRegister(payload)
    localStorage.setItem('siteiq_token', data.access_token)
    localStorage.setItem('siteiq_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }

  const logout = () => {
    localStorage.removeItem('siteiq_token')
    localStorage.removeItem('siteiq_user')
    setUser(null)
  }

  return (
    <AuthCtx.Provider value={{ user, login, register, logout, loading }}>
      {children}
    </AuthCtx.Provider>
  )
}

export const useAuth = () => useContext(AuthCtx)
