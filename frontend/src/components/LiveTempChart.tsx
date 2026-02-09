import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  TitleComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType } from 'echarts/core'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, TitleComponent, CanvasRenderer])

type Point = [number, number | null]

type LiveTempChartProps = {
  state: OvenState | null
  backlog: StatusBacklogEnvelope | null
}

function clampHistory(points: Point[], maxPoints: number): void {
  if (points.length <= maxPoints) return
  points.splice(0, points.length - maxPoints)
}

function isTargetAvailable(oven: OvenState | null): boolean {
  if (!oven) return false
  if (oven.state !== 'RUNNING') return false
  if (!Number.isFinite(oven.target)) return false
  return oven.target > 0
}

function fmtAxisTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function LiveTempChart(props: LiveTempChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)

  const seededRef = useRef(false)
  const lastPointAtRef = useRef<number | null>(null)
  const actualRef = useRef<Point[]>([])
  const targetRef = useRef<Point[]>([])

  const maxPoints = 2 * 60 * 60 // 2 hours at 1 Hz

  const baseOption = useMemo(
    () => ({
      animation: false,
      grid: { left: 40, right: 14, top: 20, bottom: 42 },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: 'rgba(255,255,255,0.78)', fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: 'rgba(12, 18, 28, 0.92)',
        borderColor: 'rgba(255,255,255,0.14)',
        textStyle: { color: 'rgba(255,255,255,0.92)' },
        valueFormatter: (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}°` : '--'),
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', start: 80, end: 100 },
        {
          type: 'slider',
          xAxisIndex: 0,
          start: 80,
          end: 100,
          height: 18,
          bottom: 10,
          backgroundColor: 'rgba(255,255,255,0.06)',
          borderColor: 'rgba(255,255,255,0.14)',
          fillerColor: 'rgba(240, 176, 74, 0.20)',
          handleStyle: { color: 'rgba(240, 176, 74, 0.65)', borderColor: 'rgba(240, 176, 74, 0.35)' },
          textStyle: { color: 'rgba(255,255,255,0.70)' },
        },
      ],
      xAxis: {
        type: 'time',
        axisLabel: { color: 'rgba(255,255,255,0.70)', formatter: (v: number) => fmtAxisTime(v) },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.16)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: 'rgba(255,255,255,0.70)' },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.16)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      },
      series: [
        {
          name: 'Actual',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 2, color: 'rgba(86, 196, 110, 0.95)' },
          emphasis: { focus: 'series' },
          data: [] as Point[],
          sampling: 'lttb',
        },
        {
          name: 'Target',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 2, type: 'dashed', color: 'rgba(240, 176, 74, 0.95)' },
          emphasis: { focus: 'series' },
          data: [] as Point[],
          sampling: 'lttb',
        },
      ],
    }),
    [],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chart.setOption(baseOption, { notMerge: true })

    const ro = new ResizeObserver(() => {
      chart.resize({ animation: { duration: 0 } })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      chartRef.current = null
      chart.dispose()
    }
  }, [baseOption])

  useEffect(() => {
    const backlog = props.backlog
    if (!backlog) return
    if (seededRef.current) return
    if (!chartRef.current) return

    const now = Date.now()
    const log = backlog.log
    const stepMs = 1000

    const actual: Point[] = []
    const target: Point[] = []

    for (let i = 0; i < log.length; i++) {
      const oven = log[i]
      const t = now - (log.length - 1 - i) * stepMs
      actual.push([t, Number.isFinite(oven.temperature) ? oven.temperature : null])
      target.push([t, isTargetAvailable(oven) ? oven.target : null])
    }

    actualRef.current = actual
    targetRef.current = target
    clampHistory(actualRef.current, maxPoints)
    clampHistory(targetRef.current, maxPoints)

    lastPointAtRef.current = now
    seededRef.current = true

    chartRef.current.setOption(
      {
        series: [{ data: actualRef.current }, { data: targetRef.current }],
      },
      { notMerge: false, lazyUpdate: true },
    )
  }, [props.backlog, maxPoints])

  useEffect(() => {
    const oven = props.state
    const chart = chartRef.current
    if (!oven || !chart) return

    const now = Date.now()
    const lastAt = lastPointAtRef.current
    if (lastAt !== null && now - lastAt < 250) return
    lastPointAtRef.current = now

    actualRef.current.push([now, Number.isFinite(oven.temperature) ? oven.temperature : null])
    targetRef.current.push([now, isTargetAvailable(oven) ? oven.target : null])
    clampHistory(actualRef.current, maxPoints)
    clampHistory(targetRef.current, maxPoints)

    // Update just series data; keep config stable.
    chart.setOption(
      {
        series: [{ data: actualRef.current }, { data: targetRef.current }],
      },
      { notMerge: false, lazyUpdate: true },
    )

    // Keep the viewport pinned to "latest" only if already near the end.
    const opt = chart.getOption()
    const zoom0 = Array.isArray(opt.dataZoom) ? (opt.dataZoom[0] as { end?: number } | undefined) : undefined
    const end = typeof zoom0?.end === 'number' ? zoom0.end : 100
    if (end >= 99.5) {
      chart.dispatchAction({ type: 'dataZoom', start: 80, end: 100 })
    }
  }, [props.state, maxPoints])

  return <div ref={hostRef} className="liveChart" aria-label="Live temperature chart" />
}
