/**
 * Shared React lifecycle hook for ECharts temperature charts.
 *
 * Encapsulates refs, zoom-hint state, chart init/cleanup,
 * and the programmatic-zoom helper that both LiveTempChart and SessionChart use.
 */

import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { EChartsType } from 'echarts/core'
import type { Point } from '../util/chartFormatting'
import { setupChart } from '../util/chartSetup'

export interface ChartCoreCallbacks {
  onManualZoom: () => void
  getDataExtent: () => { min: number; max: number } | null
  getSeriesForYRange: () => { scan: Point[][]; interpolate: Point[][] }
  minZoomMs?: number
}

export function useChartCore(
  baseOption: Record<string, unknown>,
  callbacks: ChartCoreCallbacks,
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const setupRef = useRef<ReturnType<typeof setupChart> | null>(null)
  const programmaticZoomRef = useRef(false)

  const [zoomSpanLabel, setZoomSpanLabel] = useState<string | null>(null)
  const zoomSpanHideTimerRef = useRef<number | null>(null)

  // Keep callbacks in a ref so the chart-init effect doesn't re-run when they change.
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const showZoomSpanHint = () => {
    const setup = setupRef.current
    if (!setup) return
    const label = setup.showZoomSpanHint()
    if (!label) return
    setZoomSpanLabel(label)
    if (zoomSpanHideTimerRef.current !== null) {
      window.clearTimeout(zoomSpanHideTimerRef.current)
    }
    zoomSpanHideTimerRef.current = window.setTimeout(() => {
      zoomSpanHideTimerRef.current = null
      setZoomSpanLabel(null)
    }, 900)
  }

  /**
   * Apply a programmatic zoom option without triggering the manual-zoom callback.
   * Wraps the repeated 3-line pattern: set flag -> setOption -> setTimeout reset.
   */
  const programmaticZoom = (zoomOption: Record<string, unknown>) => {
    const chart = chartRef.current
    if (!chart) return
    programmaticZoomRef.current = true
    chart.setOption(zoomOption, { notMerge: false, lazyUpdate: true })
    window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
  }

  // Chart init + cleanup effect.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const result = setupChart(
      host,
      baseOption,
      {
        onManualZoom: () => callbacksRef.current.onManualZoom(),
        getDataExtent: () => callbacksRef.current.getDataExtent(),
        getSeriesForYRange: () => callbacksRef.current.getSeriesForYRange(),
        minZoomMs: callbacksRef.current.minZoomMs,
      },
      programmaticZoomRef,
    )

    chartRef.current = result.chart
    setupRef.current = result

    return () => {
      result.destroy()
      chartRef.current = null
      setupRef.current = null
    }
  }, [baseOption])

  // Zoom span timer cleanup on unmount.
  useEffect(() => {
    return () => {
      if (zoomSpanHideTimerRef.current !== null) {
        window.clearTimeout(zoomSpanHideTimerRef.current)
        zoomSpanHideTimerRef.current = null
      }
    }
  }, [])

  return {
    hostRef,
    chartRef,
    setupRef,
    programmaticZoomRef: programmaticZoomRef as MutableRefObject<boolean>,
    zoomSpanLabel,
    showZoomSpanHint,
    programmaticZoom,
  }
}
