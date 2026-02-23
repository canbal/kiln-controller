/** Shared range-based sample fetcher. */

import { apiListSamples } from '../api/samples'
import type { SamplePoint } from '../contract/samples'

export async function fetchSamplesWindow(opts: {
  from: number
  to: number
  maxPoints: number
  signal: AbortSignal
}): Promise<SamplePoint[]> {
  const res = await apiListSamples({
    from: opts.from,
    to: opts.to,
    maxPoints: opts.maxPoints,
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(res.error)
  return res.value
}
