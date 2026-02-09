import {
  parseGetSessionResponse,
  parseListSessionSamplesResponse,
  parseListSessionsResponse,
  parsePatchSessionResponse,
} from '../contract/sessions'
import type { Session, SessionSample } from '../contract/sessions'

type ApiOk<T> = { ok: true; value: T }
type ApiErr = { ok: false; error: string }

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Accept: 'application/json',
    },
  })

  const contentType = (res.headers.get('content-type') || '').toLowerCase()
  const txt = await res.text()

  const looksJson = (() => {
    const t = txt.trimStart()
    return t.startsWith('{') || t.startsWith('[')
  })()

  let json: unknown = null
  if (txt && (contentType.includes('application/json') || looksJson)) {
    try {
      json = JSON.parse(txt)
    } catch {
      // Keep json=null; we'll raise a clear error below.
      json = null
    }
  }

  if (!res.ok) {
    const errorFromJson =
      typeof json === 'object' && json !== null && 'error' in json ? String((json as Record<string, unknown>).error) : null

    if (errorFromJson) throw new Error(errorFromJson)

    if (res.status === 404) {
      throw new Error(`HTTP_404: endpoint not found at ${path} (expected /v1/* REST endpoints)`)
    }

    throw new Error(`HTTP_${res.status} from ${path}`)
  }

  if (json === null) {
    const ct = contentType ? ` (${contentType})` : ''
    throw new Error(`Expected JSON from ${path}${ct}`)
  }

  return json
}

export async function apiListSessions(opts?: { limit?: number; offset?: number; signal?: AbortSignal }): Promise<ApiOk<Session[]> | ApiErr> {
  try {
    const qs = new URLSearchParams()
    if (typeof opts?.limit === 'number') qs.set('limit', String(opts.limit))
    if (typeof opts?.offset === 'number') qs.set('offset', String(opts.offset))

    const json = await fetchJson(`/v1/sessions${qs.toString() ? `?${qs.toString()}` : ''}`, { signal: opts?.signal })
    const parsed = parseListSessionsResponse(json)
    if (!parsed.success) return { ok: false, error: parsed.error ?? 'unknown_error' }
    return { ok: true, value: parsed.sessions ?? [] }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

export async function apiListSessionSamples(opts: {
  sessionId: string
  from?: number | null
  to?: number | null
  limit?: number
  signal?: AbortSignal
}): Promise<ApiOk<{ session: Session | null; samples: SessionSample[] }> | ApiErr> {
  try {
    const qs = new URLSearchParams()
    if (typeof opts.from === 'number') qs.set('from', String(opts.from))
    if (typeof opts.to === 'number') qs.set('to', String(opts.to))
    if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit))

    const json = await fetchJson(`/v1/sessions/${encodeURIComponent(opts.sessionId)}/samples?${qs.toString()}`, {
      signal: opts.signal,
    })
    const parsed = parseListSessionSamplesResponse(json)
    if (!parsed.success) return { ok: false, error: parsed.error ?? 'unknown_error' }

    return { ok: true, value: { session: parsed.session ?? null, samples: parsed.samples ?? [] } }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

export async function apiGetSession(opts: { sessionId: string; signal?: AbortSignal }): Promise<ApiOk<Session> | ApiErr> {
  try {
    const json = await fetchJson(`/v1/sessions/${encodeURIComponent(opts.sessionId)}`, { signal: opts.signal })
    const parsed = parseGetSessionResponse(json)
    if (!parsed.success) return { ok: false, error: parsed.error ?? 'unknown_error' }
    if (!parsed.session) return { ok: false, error: 'missing_session' }
    return { ok: true, value: parsed.session }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

export async function apiPatchSessionNotes(opts: {
  sessionId: string
  notes: string | null
  signal?: AbortSignal
}): Promise<ApiOk<Session> | ApiErr> {
  try {
    const json = await fetchJson(`/v1/sessions/${encodeURIComponent(opts.sessionId)}`, {
      method: 'PATCH',
      signal: opts.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ notes: opts.notes }),
    })
    const parsed = parsePatchSessionResponse(json)
    if (!parsed.success) return { ok: false, error: parsed.error ?? 'unknown_error' }
    if (!parsed.session) return { ok: false, error: 'missing_session' }
    return { ok: true, value: parsed.session }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}
