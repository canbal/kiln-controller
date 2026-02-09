import { parseListSessionSamplesResponse, parseListSessionsResponse } from '../contract/sessions'
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
  const txt = await res.text()
  let json: unknown
  try {
    json = txt ? JSON.parse(txt) : null
  } catch {
    throw new Error(`Non-JSON response from ${path} (status ${res.status})`)
  }
  if (!res.ok) {
    const msg =
      typeof json === 'object' && json !== null && 'error' in json
        ? String((json as Record<string, unknown>).error)
        : `HTTP_${res.status}`
    throw new Error(msg)
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
