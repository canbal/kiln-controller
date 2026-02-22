import { parseListSamplesResponse } from '../contract/samples'
import type { SamplePoint } from '../contract/samples'

type ApiOk<T> = { ok: true; value: T }
type ApiErr = { ok: false; error: string }

function isAbortError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const maybe = e as { name?: unknown; message?: unknown }
  if (maybe.name === 'AbortError') return true
  if (typeof maybe.message === 'string' && maybe.message.toLowerCase().includes('signal is aborted')) return true
  return false
}

function errMsg(e: unknown): string {
  if (isAbortError(e)) return 'aborted'
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

export async function apiListSamples(opts: {
  from?: number
  to?: number
  maxPoints?: number
  signal?: AbortSignal
}): Promise<ApiOk<SamplePoint[]> | ApiErr> {
  try {
    const qs = new URLSearchParams()
    if (typeof opts.from === 'number') qs.set('from', String(opts.from))
    if (typeof opts.to === 'number') qs.set('to', String(opts.to))
    if (typeof opts.maxPoints === 'number') qs.set('max_points', String(opts.maxPoints))

    const json = await fetchJson(`/v1/samples${qs.toString() ? `?${qs.toString()}` : ''}`, { signal: opts.signal })
    const parsed = parseListSamplesResponse(json)
    if (!parsed.success) return { ok: false, error: parsed.error ?? 'unknown_error' }
    return { ok: true, value: parsed.samples ?? [] }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}
