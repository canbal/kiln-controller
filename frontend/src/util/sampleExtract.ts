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
