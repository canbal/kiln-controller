import { useEffect, useMemo, useState } from 'react'

export type AppRoute =
  | { kind: 'dashboard' }
  | { kind: 'sessions' }
  | { kind: 'session_detail'; sessionId: string }
  | { kind: 'not_found'; raw: string }

function normalizeHash(hash: string): string {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  const trimmed = h.trim()
  if (!trimmed) return '/'
  // Allow both "#/foo" and "#foo".
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function parseAppHash(hash: string): AppRoute {
  const h = normalizeHash(hash)
  const path = h.split('?')[0] || '/'
  const parts = path.split('/').filter(Boolean)

  if (parts.length === 0) return { kind: 'dashboard' }
  if (parts[0] === 'dashboard') return { kind: 'dashboard' }
  if (parts[0] === 'sessions' && parts.length === 1) return { kind: 'sessions' }
  if (parts[0] === 'sessions' && parts.length === 2) {
    try {
      const sessionId = decodeURIComponent(parts[1] || '')
      if (!sessionId) return { kind: 'not_found', raw: hash }
      return { kind: 'session_detail', sessionId }
    } catch {
      return { kind: 'not_found', raw: hash }
    }
  }

  return { kind: 'not_found', raw: hash }
}

export function appHref(hashPath: string): string {
  const p = hashPath.startsWith('#') ? hashPath.slice(1) : hashPath
  const path = p.startsWith('/') ? p : `/${p}`
  return `#${path}`
}

export function useAppRoute(): { route: AppRoute; navigate: (hashPath: string) => void } {
  const [hash, setHash] = useState<string>(() => window.location.hash || '#/')

  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const route = useMemo(() => parseAppHash(hash), [hash])
  const navigate = (hashPath: string) => {
    window.location.hash = appHref(hashPath)
  }

  return { route, navigate }
}
