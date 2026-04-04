import { useAuthStore } from '../stores/auth'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail)
    this.name = 'ApiError'
  }
}

export async function apiCall<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts)

  if (res.status === 401) {
    useAuthStore.getState().setUnauthenticated()
    throw new ApiError(401, 'unauthorized')
  }

  const data = await res.json()

  if (!res.ok) {
    throw new ApiError(res.status, data?.error || data?.detail || `http ${res.status}`)
  }

  return data as T
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiCall<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
