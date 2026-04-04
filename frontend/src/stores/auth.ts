import { create } from 'zustand'
import type { AuthState } from '../types'

interface AuthStore extends AuthState {
  loginError: string
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  setUnauthenticated: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  loading: true,
  enabled: false,
  authenticated: false,
  loginError: '',

  refresh: async () => {
    try {
      const r = await fetch('/api/auth/me')
      const data = await r.json()
      set({
        loading: false,
        enabled: !!data.auth_enabled,
        authenticated: !!data.authenticated,
      })
    } catch {
      set({ loading: false, enabled: false, authenticated: false })
    }
  },

  login: async (password) => {
    set({ loginError: '' })
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!r.ok) {
        set({ loginError: 'invalid password' })
        return
      }
      await useAuthStore.getState().refresh()
    } catch {
      set({ loginError: 'login failed' })
    }
  },

  logout: async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      set({ authenticated: false })
      // Cross-store resets are called by the component that triggers logout
      // (AppShell), not here — avoids circular imports during store init.
    }
  },

  setUnauthenticated: () => {
    set({ authenticated: false })
  },
}))
