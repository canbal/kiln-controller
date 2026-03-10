/** Fetch session samples (server handles downsampling). */

import { apiListSessionSamples } from '../api/sessions'

export async function fetchAllSessionSamples(opts: {
  sessionId: string
  from?: number
  signal: AbortSignal
}): Promise<{ t: number; state: unknown }[]> {
  const res = await apiListSessionSamples({
    sessionId: opts.sessionId,
    from: opts.from ?? 0,
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(res.error)
  return res.value.samples.map((s) => ({ t: s.t, state: s.state }))
}
