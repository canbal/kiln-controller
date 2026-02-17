/**
 * Shared ECharts initialization and event wiring for temperature charts.
 *
 * Both LiveTempChart and RecentSessionChart call setupChart() in their
 * chart-init effect, then add component-specific behavior on top.
 */

import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  TitleComponent,
  BrushComponent,
  MarkLineComponent,
  MarkAreaComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType } from 'echarts/core'
import type { MutableRefObject } from 'react'
import type { Point } from './chartFormatting'
import { readZoomWindowValues, readZoomSpanMs, formatSpan, clampMinZoomSpan, computeVisibleYRange } from './chartZoom'

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  TitleComponent,
  BrushComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
])

export interface ChartSetupCallbacks {
  /** Called on any user-initiated zoom/pan (disable follow-live etc.) */
  onManualZoom?: () => void
  /** Return the full data extent across all series (for pct→value conversion). */
  getDataExtent: () => { min: number; max: number } | null
  /** Return series arrays for Y-axis autorange computation. */
  getSeriesForYRange: () => { scan: Point[][]; interpolate: Point[][] }
  /** Minimum zoom span in ms. Default 10000. */
  minZoomMs?: number
}

export interface ChartSetupResult {
  chart: EChartsType
  scheduleYAxisAutorange: () => void
  pointerDownRef: { current: boolean }
  programmaticZoomRef: MutableRefObject<boolean>
  /** Show the zoom span hint label. Returns the label string. */
  showZoomSpanHint: () => string | null
  destroy: () => void
}

export function setupChart(
  host: HTMLElement,
  baseOption: Record<string, unknown>,
  callbacks: ChartSetupCallbacks,
  programmaticZoomRef: MutableRefObject<boolean>,
): ChartSetupResult {
  const chart = echarts.init(host, undefined, { renderer: 'canvas' })
  chart.setOption(baseOption, { notMerge: true })

  const minZoomMs = callbacks.minZoomMs ?? 10_000

  const pointerDownRef = { current: false }
  let yAutorangeRaf: number | null = null
  let lastAppliedY: { min: number; max: number } | null = null

  // --- Y-axis autorange ---

  const scheduleYAxisAutorange = () => {
    if (yAutorangeRaf !== null) return
    yAutorangeRaf = window.requestAnimationFrame(() => {
      yAutorangeRaf = null
      const extent = callbacks.getDataExtent()
      const win = readZoomWindowValues(chart, extent)
      if (!win) return

      const { scan, interpolate } = callbacks.getSeriesForYRange()
      const next = computeVisibleYRange(win, scan, interpolate)
      if (!next) return

      const changed =
        !lastAppliedY || Math.abs(lastAppliedY.min - next.min) > 0.25 || Math.abs(lastAppliedY.max - next.max) > 0.25
      if (!changed) return
      lastAppliedY = next

      chart.setOption(
        { yAxis: { min: next.min, max: next.max } },
        { notMerge: false, lazyUpdate: true },
      )
    })
  }

  // Expose a way to reset lastAppliedY (e.g. on data reload)
  const resetLastAppliedY = () => { lastAppliedY = null }

  // --- Zoom span hint ---

  const showZoomSpanHint = (): string | null => {
    const extent = callbacks.getDataExtent()
    const spanMs = readZoomSpanMs(chart, extent)
    if (!spanMs) return null
    return formatSpan(spanMs)
  }

  // --- Brush ---

  const activateBrush = () => {
    chart.dispatchAction({
      type: 'takeGlobalCursor',
      key: 'brush',
      brushOption: { brushType: 'lineX', brushMode: 'single' },
    })
  }
  activateBrush()

  const onBrushEnd = (...args: unknown[]) => {
    const params = (args[0] ?? {}) as Record<string, unknown>
    const areas = (params as { areas?: { coordRange?: [number, number] }[] }).areas
    if (!areas?.length) return
    const range = areas[0]?.coordRange
    if (!range || range.length < 2) return

    const [startValue, endValue] = range
    if (!(endValue > startValue)) return

    // Clear the brush selection immediately.
    chart.dispatchAction({ type: 'brush', areas: [] })

    // Apply zoom.
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

    callbacks.onManualZoom?.()

    window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
    scheduleYAxisAutorange()

    // Re-activate brush so the next drag works immediately.
    activateBrush()
  }
  chart.on('brushEnd', onBrushEnd)

  // --- DataZoom handler ---

  const onDataZoom = () => {
    // Always fit the y-axis to the currently visible x-window.
    scheduleYAxisAutorange()

    // For programmatic zoom changes, skip the follow/lock behavior.
    if (programmaticZoomRef.current) return

    // Enforce a minimum zoom span.
    const extent = callbacks.getDataExtent()
    const readWindow = () => readZoomWindowValues(chart, extent)
    const { clamped } = clampMinZoomSpan(chart, minZoomMs, extent, readWindow, programmaticZoomRef)
    if (clamped) {
      callbacks.onManualZoom?.()
      return
    }

    // Convert to value-based zoom so it's immune to data extent changes.
    const win = readZoomWindowValues(chart, extent)
    if (win) {
      programmaticZoomRef.current = true
      chart.setOption(
        {
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue: win.startValue, endValue: win.endValue },
            { rangeMode: ['value', 'value'], startValue: win.startValue, endValue: win.endValue },
          ],
        },
        { notMerge: false, lazyUpdate: true },
      )
      window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
    }

    callbacks.onManualZoom?.()
  }
  chart.on('dataZoom', onDataZoom)

  // --- Pointer tracking ---

  const onPointerDown = () => { pointerDownRef.current = true }
  const onPointerUp = () => { pointerDownRef.current = false }
  host.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)

  // --- Resize ---

  const ro = new ResizeObserver(() => {
    chart.resize({ animation: { duration: 0 } })
  })
  ro.observe(host)

  // --- Cleanup ---

  const destroy = () => {
    ro.disconnect()
    host.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
    chart.off('brushEnd', onBrushEnd)
    chart.off('dataZoom', onDataZoom)
    if (yAutorangeRaf !== null) {
      window.cancelAnimationFrame(yAutorangeRaf)
      yAutorangeRaf = null
    }
    chart.dispose()
  }

  // Attach resetLastAppliedY to scheduleYAxisAutorange for external access.
  ;(scheduleYAxisAutorange as { resetLastAppliedY?: () => void }).resetLastAppliedY = resetLastAppliedY

  return { chart, scheduleYAxisAutorange, pointerDownRef, programmaticZoomRef, showZoomSpanHint, destroy }
}

/** Reset the cached Y-axis range so the next autorange recalculates from scratch. */
export function resetYAxisCache(scheduleYAxisAutorange: () => void): void {
  const fn = scheduleYAxisAutorange as { resetLastAppliedY?: () => void }
  fn.resetLastAppliedY?.()
}
