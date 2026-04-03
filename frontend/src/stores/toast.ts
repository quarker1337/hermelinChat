import { create } from 'zustand'

interface Toast {
  id: string
  text: string
}

interface ToastStore {
  toast: Toast | null
  show: (text: string, ms?: number) => void
}

let _timer: ReturnType<typeof setTimeout> | null = null

export const useToastStore = create<ToastStore>((set) => ({
  toast: null,

  show: (text, ms = 2600) => {
    const t = (text || '').toString().trim()
    if (!t) return

    const id =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`

    set({ toast: { id, text: t } })

    if (_timer) clearTimeout(_timer)
    _timer = setTimeout(() => {
      set({ toast: null })
      _timer = null
    }, ms)
  },
}))
