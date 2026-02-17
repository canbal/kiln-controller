/** Shared paginated session sample fetcher. */

import { apiListSessionSamples } from '../api/sessions'

const PAGE_SIZE = 5000

export async function fetchAllSessionSamples(opts: {
  sessionId: string
  from?: number
  signal: AbortSignal
}): Promise<{ t: number; state: unknown }[]> {
  const all: { t: number; state: unknown }[] = []
  let pageFrom = opts.from ?? 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await apiListSessionSamples({
      sessionId: opts.sessionId,
      from: pageFrom,
      limit: PAGE_SIZE,
      signal: opts.signal,
    })
    if (!res.ok) throw new Error(res.error)
    const chunk = res.value.samples
    for (const s of chunk) all.push({ t: s.t, state: s.state })
    if (chunk.length < PAGE_SIZE) break
    // Advance past the last sample's timestamp for the next page.
    pageFrom = chunk[chunk.length - 1].t + 1
  }

  // Dedupe by timestamp.
  const seen = new Set<number>()
  const deduped = all.filter((s) => {
    if (seen.has(s.t)) return false
    seen.add(s.t)
    return true
  })
  deduped.sort((a, b) => a.t - b.t)
  return deduped
}
