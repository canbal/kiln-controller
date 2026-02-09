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
  const contentType = (res.headers.get('content-type') || '').toLowerCase()

  let json: unknown = null
  const looksJson = (() => {
    const t = txt.trimStart()
    return t.startsWith('{') || t.startsWith('[')
  })()
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
    throw new Error(errorFromJson || `HTTP_${res.status}`)
  }

  if (json === null) throw new Error(`Expected JSON from ${path}`)
  return json
}

export type UiTheme = 'stoneware' | 'dark'

// Back-compat: earlier experiments used `paper`. Treat as light.
function normalizeTheme(v: unknown): UiTheme {
  if (v === 'dark') return 'dark'
  return 'stoneware'
}

export async function apiGetTheme(opts?: { signal?: AbortSignal }): Promise<ApiOk<UiTheme> | ApiErr> {
  try {
    const json = await fetchJson('/v1/settings/theme', { signal: opts?.signal })
    if (!json || typeof json !== 'object') return { ok: false, error: 'invalid_response' }
    const theme = (json as Record<string, unknown>).theme
    return { ok: true, value: normalizeTheme(theme) }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

export async function apiSetTheme(theme: UiTheme, opts?: { signal?: AbortSignal }): Promise<ApiOk<UiTheme> | ApiErr> {
  try {
    const json = await fetchJson('/v1/settings/theme', {
      method: 'PATCH',
      signal: opts?.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ theme }),
    })
    if (!json || typeof json !== 'object') return { ok: false, error: 'invalid_response' }
    const out = (json as Record<string, unknown>).theme
    return { ok: true, value: normalizeTheme(out) }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}
