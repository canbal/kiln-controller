/** Shared formatting helpers for temperature charts. */

export type Point = [number, number | null]

export function fmtTemp(v: number): string {
  if (!Number.isFinite(v)) return '--'
  const rounded = Math.round(v)
  if (Math.abs(v - rounded) < 0.05) return String(rounded)
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

export function fmtAxisTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
