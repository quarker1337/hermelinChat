import { create } from 'zustand'
import type { AuthState } from '../types'

interface AuthStore extends AuthState {
  loginError: string
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: (options?: { preserveEnabledOnError?: boolean }) => Promise<void>
  setUnauthenticated: (reason?: 'explicit' | 'expired') => void
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  loading: true,
  enabled: false,
  authenticated: false,
  logoutReason: null,
  sessionTtlSeconds: null,
  loginError: '',

  refresh: async (options) => {
    try {
      const r = await fetch('/api/auth/me')
      const data = await r.json()
      set({
        loading: false,
        enabled: !!data.auth_enabled,
        authenticated: !!data.authenticated,
        logoutReason: data.authenticated ? null : 'expired',
        sessionTtlSeconds: typeof data.session_ttl_seconds === 'number' ? data.session_ttl_seconds : null,
      })
    } catch {
      set({
        loading: false,
        enabled: options?.preserveEnabledOnError ? get().enabled : false,
        authenticated: false,
        logoutReason: 'expired',
        sessionTtlSeconds: options?.preserveEnabledOnError ? get().sessionTtlSeconds : null,
      })
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
      if (useAuthStore.getState().authenticated) {
        set({ logoutReason: null })
      }
    } catch {
      set({ loginError: 'login failed' })
    }
  },

  logout: async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      set({ authenticated: false, logoutReason: 'explicit' })
      // Cross-store resets are called by the component that triggers logout
      // (AppShell), not here — avoids circular imports during store init.
    }
  },

  setUnauthenticated: (reason = 'expired') => {
    set({ authenticated: false, logoutReason: reason })
  },
}))
