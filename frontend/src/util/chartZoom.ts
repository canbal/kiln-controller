/** Shared zoom / Y-axis autorange logic for temperature charts. */

import type { EChartsType } from 'echarts/core'
import type { MutableRefObject, RefObject } from 'react'
import type { Point } from './chartFormatting'

// ---------------------------------------------------------------------------
// Read current zoom window as absolute values (with pct→value fallback)
// ---------------------------------------------------------------------------

export function readZoomWindowValues(
  chart: EChartsType,
  dataExtent: { min: number; max: number } | null,
): { startValue: number; endValue: number } | null {
  const opt = chart.getOption()
  const zoom0 = Array.isArray(opt.dataZoom) ? (opt.dataZoom[0] as Record<string, unknown> | undefined) : undefined
  if (!zoom0) return null

  const startValue = typeof zoom0.startValue === 'number' ? zoom0.startValue : null
  const endValue = typeof zoom0.endValue === 'number' ? zoom0.endValue : null
  if (startValue !== null && endValue !== null) {
    return { startValue, endValue }
  }

  const start = typeof zoom0.start === 'number' ? zoom0.start : null
  const end = typeof zoom0.end === 'number' ? zoom0.end : null
  if (!dataExtent || start === null || end === null) return null

  const toValue = (pct: number) => dataExtent.min + ((dataExtent.max - dataExtent.min) * pct) / 100
  return { startValue: toValue(start), endValue: toValue(end) }
}

// ---------------------------------------------------------------------------
// Compute Y-axis range from visible data in current zoom window
// ---------------------------------------------------------------------------

export function computeVisibleYRange(
  window: { startValue: number; endValue: number },
  scanSeries: Point[][],
  interpolateSeries: Point[][],
): { min: number; max: number } | null {
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const scan = (pts: Point[]) => {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const t = p[0]
      const y = p[1]
      if (t < window.startValue || t > window.endValue) continue
      if (y === null || !Number.isFinite(y)) continue
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  // For sparse series (schedule), also consider interpolated line segments
  // that cross the zoom window even when no waypoints fall inside it.
  const scanInterpolated = (pts: Point[]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, y0] = pts[i]
      const [t1, y1] = pts[i + 1]
      if (y0 === null || y1 === null || !Number.isFinite(y0) || !Number.isFinite(y1)) continue
      if (t1 < window.startValue || t0 > window.endValue) continue
      const lerp = (t: number) => y0 + (y1 - y0) * ((t - t0) / (t1 - t0))
      const ys = t0 >= window.startValue ? y0 : lerp(window.startValue)
      const ye = t1 <= window.endValue ? y1 : lerp(window.endValue)
      if (ys < minY) minY = ys
      if (ys > maxY) maxY = ys
      if (ye < minY) minY = ye
      if (ye > maxY) maxY = ye
    }
  }

  for (const pts of scanSeries) scan(pts)
  for (const pts of interpolateSeries) scanInterpolated(pts)

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null

  let span = maxY - minY
  if (!(span > 0)) span = 1
  const pad = Math.max(1, span * 0.08)
  const min = minY - pad
  const max = maxY + pad

  // Avoid zero-span axis.
  if (max - min < 2) {
    const mid = (max + min) / 2
    return { min: mid - 1, max: mid + 1 }
  }
  return { min, max }
}

// ---------------------------------------------------------------------------
// Factory: returns RAF-debounced scheduleYAxisAutorange() callback
// ---------------------------------------------------------------------------

export function createYAxisAutorange(
  chartRef: RefObject<EChartsType | null>,
  lastAppliedYRef: MutableRefObject<{ min: number; max: number } | null>,
  yAutorangeRafRef: MutableRefObject<number | null>,
  getVisibleRange: () => { min: number; max: number } | null,
): () => void {
  return () => {
    if (yAutorangeRafRef.current !== null) return
    yAutorangeRafRef.current = window.requestAnimationFrame(() => {
      yAutorangeRafRef.current = null
      const chart = chartRef.current
      if (!chart) return
      const next = getVisibleRange()
      if (!next) return

      const prev = lastAppliedYRef.current
      const changed =
        !prev || Math.abs(prev.min - next.min) > 0.25 || Math.abs(prev.max - next.max) > 0.25
      if (!changed) return
      lastAppliedYRef.current = next

      chart.setOption(
        { yAxis: { min: next.min, max: next.max } },
        { notMerge: false, lazyUpdate: true },
      )
    })
  }
}

// ---------------------------------------------------------------------------
// Read zoom span in ms
// ---------------------------------------------------------------------------

export function readZoomSpanMs(
  chart: EChartsType,
  dataExtent: { min: number; max: number } | null,
): number | null {
  const opt = chart.getOption()
  const zoom0 = Array.isArray(opt.dataZoom) ? (opt.dataZoom[0] as Record<string, unknown> | undefined) : undefined
  if (!zoom0) return null

  const startValue = typeof zoom0.startValue === 'number' ? zoom0.startValue : null
  const endValue = typeof zoom0.endValue === 'number' ? zoom0.endValue : null
  if (startValue !== null && endValue !== null && endValue > startValue) {
    return endValue - startValue
  }

  const start = typeof zoom0.start === 'number' ? zoom0.start : null
  const end = typeof zoom0.end === 'number' ? zoom0.end : null
  if (!dataExtent || start === null || end === null) return null

  const spanPct = Math.max(0, Math.min(100, end - start)) / 100
  const span = (dataExtent.max - dataExtent.min) * spanPct
  return span > 0 ? span : null
}

// ---------------------------------------------------------------------------
// Format zoom span for the hint label
// ---------------------------------------------------------------------------

export function formatSpan(ms: number): string {
  const s = ms / 1000
  if (s >= 3600) {
    const h = Math.max(1, Math.round(s / 3600))
    return `${h} hr`
  }
  if (s >= 60) {
    const m = Math.max(1, Math.round(s / 60))
    return `${m} min`
  }
  const sec = Math.max(1, Math.round(s))
  return `${sec} sec`
}

// ---------------------------------------------------------------------------
// Enforce minimum zoom span — used in dataZoom handler
// ---------------------------------------------------------------------------

export function clampMinZoomSpan(
  chart: EChartsType,
  minMs: number,
  dataExtent: { min: number; max: number } | null,
  readWindow: () => { startValue: number; endValue: number } | null,
  programmaticZoomRef: MutableRefObject<boolean>,
): { clamped: boolean; spanLabel?: string } {
  if (!dataExtent) return { clamped: false }
  const fullSpan = dataExtent.max - dataExtent.min
  if (fullSpan <= 0) return { clamped: false }

  const win = readWindow()
  if (!win) return { clamped: false }

  const span = win.endValue - win.startValue
  if (!(span > 0) || span >= minMs) return { clamped: false }

  // If we don't have enough data to support the minimum span, show full extent.
  if (fullSpan < minMs) {
    programmaticZoomRef.current = true
    chart.setOption(
      {
        dataZoom: [
          { rangeMode: ['value', 'value'], startValue: dataExtent.min, endValue: dataExtent.max },
          { rangeMode: ['value', 'value'], startValue: dataExtent.min, endValue: dataExtent.max },
        ],
      },
      { notMerge: false, lazyUpdate: true },
    )
    window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
    return { clamped: true, spanLabel: formatSpan(fullSpan) }
  }

  const center = (win.startValue + win.endValue) / 2
  let startValue = center - minMs / 2
  let endValue = center + minMs / 2

  if (startValue < dataExtent.min) {
    const d = dataExtent.min - startValue
    startValue += d
    endValue += d
  }
  if (endValue > dataExtent.max) {
    const d = endValue - dataExtent.max
    startValue -= d
    endValue -= d
  }

  startValue = Math.max(dataExtent.min, startValue)
  endValue = Math.min(dataExtent.max, endValue)

  programmaticZoomRef.current = true
  chart.setOption(
    {
      dataZoom: [
        { rangeMode: ['value', 'value'], startValue, endValue },
        { rangeMode: ['value', 'value'], startValue, endValue },
      ],
    },
    { notMerge: false, lazyUpdate: true },
  )
  window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
  return { clamped: true, spanLabel: formatSpan(endValue - startValue) }
}
