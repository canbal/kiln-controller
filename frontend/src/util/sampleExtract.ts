/** Shared helpers for extracting temperature values from session sample state objects. */

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function extractTemp(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null
  const v = (state as Record<string, unknown>).temperature
  return isFiniteNumber(v) ? v : null
}

export function extractTarget(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null
  const s = (state as Record<string, unknown>).state
  const v = (state as Record<string, unknown>).target
  if (s !== 'RUNNING') return null
  return isFiniteNumber(v) && v > 0 ? v : null
}

export function extractPowerPercent(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null
  const pidstats = (state as Record<string, unknown>).pidstats
  if (!pidstats || typeof pidstats !== 'object') return null
  const v = (pidstats as Record<string, unknown>).out
  if (!isFiniteNumber(v)) return null
  const pct = v * 100
  if (!Number.isFinite(pct)) return null
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}
