import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  TitleComponent,
  BrushComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType } from 'echarts/core'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, TitleComponent, BrushComponent, CanvasRenderer])

type Point = [number, number | null]

type LiveTempChartProps = {
  state: OvenState | null
  backlog: StatusBacklogEnvelope | null
  tempScale: 'f' | 'c' | null
  theme?: 'stoneware' | 'dark'
}

function fmtTemp(v: number): string {
  // Keep labels stable but allow sub-degree resolution.
  if (!Number.isFinite(v)) return '--'
  const rounded = Math.round(v)
  if (Math.abs(v - rounded) < 0.05) return String(rounded)
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
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

type ChartScheme = {
  seriesActual: string
  seriesTarget: string
  seriesSchedule: string
  text: string
  textStrong: string
  line: string
  grid: string
  tooltipBg: string
  tooltipBorder: string
  zoomBg: string
  zoomBorder: string
  zoomFill: string
  zoomHandle: string
  zoomHandleBorder: string
}

function schemeForTheme(theme: 'stoneware' | 'dark'): ChartScheme {
  if (theme === 'stoneware') {
    return {
      seriesActual: 'rgba(56, 109, 140, 0.95)',
      seriesTarget: 'rgba(138, 90, 68, 0.95)',
      seriesSchedule: 'rgba(90, 140, 90, 0.70)',
      text: 'rgba(45, 35, 28, 0.72)',
      textStrong: 'rgba(45, 35, 28, 0.92)',
      line: 'rgba(70, 55, 44, 0.22)',
      grid: 'rgba(70, 55, 44, 0.08)',
      tooltipBg: 'rgba(251, 248, 242, 0.98)',
      tooltipBorder: 'rgba(70, 55, 44, 0.16)',
      zoomBg: 'rgba(70, 55, 44, 0.04)',
      zoomBorder: 'rgba(70, 55, 44, 0.14)',
      zoomFill: 'rgba(138, 90, 68, 0.16)',
      zoomHandle: 'rgba(138, 90, 68, 0.45)',
      zoomHandleBorder: 'rgba(138, 90, 68, 0.22)',
    }
  }

  // dark
  return {
    seriesActual: 'rgba(75, 160, 255, 0.95)',
    seriesTarget: 'rgba(240, 176, 74, 0.95)',
    seriesSchedule: 'rgba(120, 200, 120, 0.70)',
    text: 'rgba(255, 255, 255, 0.78)',
    textStrong: 'rgba(255, 255, 255, 0.92)',
    line: 'rgba(255, 255, 255, 0.16)',
    grid: 'rgba(255, 255, 255, 0.08)',
    tooltipBg: 'rgba(12, 18, 28, 0.92)',
    tooltipBorder: 'rgba(255, 255, 255, 0.14)',
    zoomBg: 'rgba(255, 255, 255, 0.06)',
    zoomBorder: 'rgba(255, 255, 255, 0.14)',
    zoomFill: 'rgba(240, 176, 74, 0.20)',
    zoomHandle: 'rgba(240, 176, 74, 0.65)',
    zoomHandleBorder: 'rgba(240, 176, 74, 0.35)',
  }
}

export function LiveTempChart(props: LiveTempChartProps) {
  const theme = props.theme ?? 'stoneware'
  const scheme = useMemo(() => schemeForTheme(theme), [theme])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)

  const [followLive, setFollowLive] = useState(true)
  const followLiveRef = useRef(true)
  const [autoLiveWindow, setAutoLiveWindow] = useState(true)
  const programmaticZoomRef = useRef(false)
  const zoomSpanPctRef = useRef(20)


  // Default live view behavior:
  // - until we have >= LIVE_WINDOW_MS of data, show the full extent (max zoomed out)
  // - after that, lock the window to exactly LIVE_WINDOW_MS and pan with new data
  // If the user manually zooms/pans, we stop enforcing this until they hit Reset.
  const autoLiveWindowRef = useRef(true)

  const [zoomSpanLabel, setZoomSpanLabel] = useState<string | null>(null)
  const zoomSpanHideTimerRef = useRef<number | null>(null)

  // True while the user is actively dragging on the chart (slider, brush, etc.).
  // Data ticks skip chart.setOption() during this to avoid interrupting ECharts' drag state.
  const pointerDownRef = useRef(false)

  const seededRef = useRef(false)
  const lastPointAtRef = useRef<number | null>(null)
  const actualRef = useRef<Point[]>([])
  const targetRef = useRef<Point[]>([])
  const scheduleRef = useRef<Point[]>([])

  const maxPoints = 2 * 60 * 60 // 2 hours at 1 Hz
  const LIVE_WINDOW_MS = 30 * 60 * 1000
  const MIN_ZOOM_MS = 10 * 1000

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)

  const lastAppliedYRef = useRef<{ min: number; max: number } | null>(null)
  const yAutorangeRafRef = useRef<number | null>(null)

  useEffect(() => {
    unitRef.current = unit
  }, [unit])

  // Extent of actual data only — used for live zoom logic (auto window, reset, follow-live).
  const timeExtent = () => {
    const pts = actualRef.current
    if (pts.length < 2) return null
    const min = pts[0][0]
    const max = pts[pts.length - 1][0]
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
    return { min, max }
  }

  // Extent of ALL series — matches ECharts' internal percentage space.
  // Used for percentage↔value conversion when reading zoom state.
  const chartDataExtent = () => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    const update = (pts: Point[]) => {
      if (pts.length === 0) return
      const first = pts[0][0]
      const last = pts[pts.length - 1][0]
      if (Number.isFinite(first) && first < min) min = first
      if (Number.isFinite(last) && last > max) max = last
    }
    update(actualRef.current)
    update(targetRef.current)
    update(scheduleRef.current)
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
    return { min, max }
  }

  const computeVisibleYRange = (chart: EChartsType): { min: number; max: number } | null => {
    const win = readZoomWindowValues(chart)
    if (!win) return null

    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    const scan = (pts: Point[]) => {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]
        const t = p[0]
        const y = p[1]
        if (t < win.startValue || t > win.endValue) continue
        if (y === null) continue
        if (!Number.isFinite(y)) continue
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
        if (t1 < win.startValue || t0 > win.endValue) continue
        const lerp = (t: number) => y0 + (y1 - y0) * ((t - t0) / (t1 - t0))
        const ys = t0 >= win.startValue ? y0 : lerp(win.startValue)
        const ye = t1 <= win.endValue ? y1 : lerp(win.endValue)
        if (ys < minY) minY = ys
        if (ys > maxY) maxY = ys
        if (ye < minY) minY = ye
        if (ye > maxY) maxY = ye
      }
    }

    scan(actualRef.current)
    scan(targetRef.current)
    scanInterpolated(scheduleRef.current)

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

  const scheduleYAxisAutorange = (chart: EChartsType) => {
    if (yAutorangeRafRef.current !== null) return
    yAutorangeRafRef.current = window.requestAnimationFrame(() => {
      yAutorangeRafRef.current = null
      const next = computeVisibleYRange(chart)
      if (!next) return

      const prev = lastAppliedYRef.current
      const changed =
        !prev || Math.abs(prev.min - next.min) > 0.25 || Math.abs(prev.max - next.max) > 0.25
      if (!changed) return
      lastAppliedYRef.current = next

      chart.setOption(
        {
          yAxis: {
            min: next.min,
            max: next.max,
          },
        },
        { notMerge: false, lazyUpdate: true },
      )
    })
  }

  const readZoomWindowPct = (chart: EChartsType): { startPct: number; endPct: number } | null => {
    const extent = timeExtent()
    if (!extent) return null
    const win = readZoomWindowValues(chart)
    if (!win) return null
    const toPct = (v: number) => ((v - extent.min) / (extent.max - extent.min)) * 100
    return {
      startPct: Math.max(0, Math.min(100, toPct(win.startValue))),
      endPct: Math.max(0, Math.min(100, toPct(win.endValue))),
    }
  }

  const readZoomSpanMs = (chart: EChartsType): number | null => {
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
    const extent = chartDataExtent()
    if (!extent || start === null || end === null) return null

    const spanPct = Math.max(0, Math.min(100, end - start)) / 100
    const span = (extent.max - extent.min) * spanPct
    return span > 0 ? span : null
  }

  const readZoomWindowValues = (chart: EChartsType): { startValue: number; endValue: number } | null => {
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
    const extent = chartDataExtent()
    if (!extent || start === null || end === null) return null

    const toValue = (pct: number) => extent.min + ((extent.max - extent.min) * pct) / 100
    return { startValue: toValue(start), endValue: toValue(end) }
  }

  const formatSpan = (ms: number): string => {
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

  const showZoomSpanHint = (chart: EChartsType) => {
    const spanMs = readZoomSpanMs(chart)
    if (!spanMs) return

    setZoomSpanLabel(formatSpan(spanMs))
    if (zoomSpanHideTimerRef.current !== null) {
      window.clearTimeout(zoomSpanHideTimerRef.current)
    }
    zoomSpanHideTimerRef.current = window.setTimeout(() => {
      zoomSpanHideTimerRef.current = null
      setZoomSpanLabel(null)
    }, 900)
  }

  const clampMinZoomSpanIfNeeded = (chart: EChartsType): boolean => {
    const extent = timeExtent()
    if (!extent) return false
    const fullSpan = extent.max - extent.min
    if (fullSpan <= 0) return false

    const win = readZoomWindowValues(chart)
    if (!win) return false

    const span = win.endValue - win.startValue
    if (!(span > 0) || span >= MIN_ZOOM_MS) return false

    // If we don't have enough data to support the minimum span, show full extent.
    if (fullSpan < MIN_ZOOM_MS) {
      programmaticZoomRef.current = true
      chart.setOption(
        {
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
            { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
          ],
        },
        { notMerge: false, lazyUpdate: true },
      )
      window.setTimeout(() => {
        programmaticZoomRef.current = false
      }, 0)
      setZoomSpanLabel(formatSpan(fullSpan))
      return true
    }

    const center = (win.startValue + win.endValue) / 2
    let startValue = center - MIN_ZOOM_MS / 2
    let endValue = center + MIN_ZOOM_MS / 2

    if (startValue < extent.min) {
      const d = extent.min - startValue
      startValue += d
      endValue += d
    }
    if (endValue > extent.max) {
      const d = endValue - extent.max
      startValue -= d
      endValue -= d
    }

    startValue = Math.max(extent.min, startValue)
    endValue = Math.min(extent.max, endValue)

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
    window.setTimeout(() => {
      programmaticZoomRef.current = false
    }, 0)
    setZoomSpanLabel(formatSpan(endValue - startValue))
    return true
  }

  const resetToLive = () => {
    const chart = chartRef.current
    followLiveRef.current = true
    setFollowLive(true)
    setAutoLiveWindow(true)
    if (!chart) return

    zoomSpanPctRef.current = 20
    autoLiveWindowRef.current = true

    programmaticZoomRef.current = true
    // Apply the default live window behavior immediately.
    const extent = timeExtent()
    if (extent) {
      const span = extent.max - extent.min
      if (span < LIVE_WINDOW_MS) {
        chart.setOption(
          {
            dataZoom: [
              { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
              { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
            ],
          },
          { notMerge: false, lazyUpdate: true },
        )
      } else {
        const endValue = extent.max
        const startValue = endValue - LIVE_WINDOW_MS
        chart.setOption(
          {
            dataZoom: [
              { rangeMode: ['value', 'value'], startValue, endValue },
              { rangeMode: ['value', 'value'], startValue, endValue },
            ],
          },
          { notMerge: false, lazyUpdate: true },
        )
      }
    } else {
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
    }
    window.setTimeout(() => {
      programmaticZoomRef.current = false
    }, 0)
  }

  const applyAutoLiveWindow = (chart: EChartsType) => {
    const extent = timeExtent()
    if (!extent) return

    const span = extent.max - extent.min
    if (span < LIVE_WINDOW_MS) {
      programmaticZoomRef.current = true
      chart.setOption(
        {
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
            { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
          ],
        },
        { notMerge: false, lazyUpdate: true },
      )
      window.setTimeout(() => {
        programmaticZoomRef.current = false
      }, 0)
      return
    }

    const endValue = extent.max
    const startValue = endValue - LIVE_WINDOW_MS
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
    window.setTimeout(() => {
      programmaticZoomRef.current = false
    }, 0)
  }

  const baseOption = useMemo(
    () => ({
      animation: false,
      grid: { left: 58, right: 14, top: 34, bottom: 54 },
      brush: {
        toolbox: [],
        xAxisIndex: 0,
        brushType: 'lineX',
        brushMode: 'single',
        transformable: false,
        throttleType: 'debounce',
        throttleDelay: 0,
        brushStyle: {
          borderWidth: 1,
          color: 'rgba(120, 140, 180, 0.15)',
          borderColor: 'rgba(120, 140, 180, 0.5)',
        },
      },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: scheme.text, fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: scheme.tooltipBg,
        borderColor: scheme.tooltipBorder,
        textStyle: { color: scheme.textStrong },
        valueFormatter: (v: unknown) => {
          const u = unitRef.current
          return typeof v === 'number' && Number.isFinite(v) ? `${fmtTemp(v)}°${u}` : '--'
        },
      },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          start: 80,
          end: 100,
          // Trackpad/two-finger scroll should pan, not zoom.
          // Allow zoom via pinch gesture (typically emits ctrl+wheel) or ctrl+wheel.
          zoomOnMouseWheel: 'ctrl',
          moveOnMouseWheel: true,
        },
        {
          type: 'slider',
          xAxisIndex: 0,
          start: 80,
          end: 100,
          height: 18,
          bottom: 10,
          backgroundColor: scheme.zoomBg,
          borderColor: scheme.zoomBorder,
          fillerColor: scheme.zoomFill,
          handleStyle: { color: scheme.zoomHandle, borderColor: scheme.zoomHandleBorder },
          textStyle: { color: scheme.text },
          // Keep mousewheel pan behavior consistent with the inside zoom.
          zoomOnMouseWheel: 'ctrl',
          moveOnMouseWheel: true,
        },
      ],
      xAxis: {
        type: 'time',
        // Prevent duplicate labels like 06:51 06:51 06:51 when the axis ticks are < 1 minute.
        minInterval: 60_000,
        axisLabel: {
          color: scheme.text,
          formatter: (v: number) => fmtAxisTime(v),
          hideOverlap: true,
        },
        axisLine: { lineStyle: { color: scheme.line } },
        splitLine: { lineStyle: { color: scheme.grid } },
      },
      yAxis: {
        type: 'value',
        boundaryGap: ['10%', '10%'],
        // Never show sub-0.5 degree tick steps (requirement is phrased in F, but
        // using the same minimum keeps the axis legible in both scales).
        minInterval: 0.5,
        axisLabel: {
          color: scheme.text,
          formatter: (v: number) => {
            const u = unitRef.current
            return Number.isFinite(v) ? `${fmtTemp(v)}°${u}` : '--'
          },
        },
        axisLine: { lineStyle: { color: scheme.line } },
        splitLine: { lineStyle: { color: scheme.grid } },
      },
      series: [
        {
          name: 'Actual',
          type: 'line',
          showSymbol: false,
          itemStyle: { color: scheme.seriesActual },
          lineStyle: { width: 2, color: scheme.seriesActual },
          emphasis: { focus: 'series' },
          data: [] as Point[],
          sampling: 'lttb',
        },
        {
          name: 'Target',
          type: 'line',
          showSymbol: false,
          itemStyle: { color: scheme.seriesTarget },
          lineStyle: { width: 2, type: 'dashed', color: scheme.seriesTarget },
          emphasis: { focus: 'series' },
          data: [] as Point[],
          sampling: 'lttb',
        },
        {
          name: 'Schedule',
          type: 'line',
          z: 1,
          showSymbol: true,
          symbolSize: 6,
          symbol: 'circle',
          itemStyle: { color: scheme.seriesSchedule },
          lineStyle: { width: 1.5, type: 'dotted', color: scheme.seriesSchedule },
          emphasis: { focus: 'series' },
          data: [] as Point[],
        },
      ],
    }),
    [scheme],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    chart.setOption(baseOption, { notMerge: true })

    // Activate brush immediately so user can click+drag without clicking a button.
    const activateBrush = () => {
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      })
    }
    activateBrush()

    // Brush-to-zoom: when user drags a region, zoom the x-axis to it.
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

      // Treat as manual zoom.
      autoLiveWindowRef.current = false
      setAutoLiveWindow(false)
      followLiveRef.current = false
      setFollowLive(false)

      window.setTimeout(() => {
        programmaticZoomRef.current = false
      }, 0)

      scheduleYAxisAutorange(chart)

      // Re-activate brush so the next drag works immediately.
      activateBrush()
    }
    chart.on('brushEnd', onBrushEnd)

    const onDataZoom = () => {
      // Always fit the y-axis to the currently visible x-window, even for
      // programmatic zoom changes (Reset/auto live window).
      scheduleYAxisAutorange(chart)

      // For programmatic zoom changes, skip the follow/lock behavior.
      if (programmaticZoomRef.current) return

      // Enforce a minimum zoom span (prevents zooming in too far).
      if (clampMinZoomSpanIfNeeded(chart)) {
        autoLiveWindowRef.current = false
        setAutoLiveWindow(false)
        followLiveRef.current = false
        setFollowLive(false)

        if (zoomSpanHideTimerRef.current !== null) {
          window.clearTimeout(zoomSpanHideTimerRef.current)
        }
        zoomSpanHideTimerRef.current = window.setTimeout(() => {
          zoomSpanHideTimerRef.current = null
          setZoomSpanLabel(null)
        }, 900)
        return
      }

      showZoomSpanHint(chart)

      // Any manual dataZoom interaction disables follow-live and auto-live-window.
      // Only clicking "Reset Zoom" restores them.
      autoLiveWindowRef.current = false
      setAutoLiveWindow(false)
      followLiveRef.current = false
      setFollowLive(false)

      // Convert to value-based zoom so it's immune to data extent changes
      // when new samples arrive. Without this, percentage-based zoom (from
      // slider/pinch) would shift as the actual data extent grows.
      const win = readZoomWindowValues(chart)
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
        window.setTimeout(() => {
          programmaticZoomRef.current = false
        }, 0)
      }
    }

    chart.on('dataZoom', onDataZoom)

    // Track pointer down/up to pause live updates while the user is dragging
    // the slider bar (or brush-selecting). Releasing anywhere ends the drag.
    const onPointerDown = () => {
      pointerDownRef.current = true
    }
    const onPointerUp = () => {
      pointerDownRef.current = false
    }
    host.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)

    const ro = new ResizeObserver(() => {
      chart.resize({ animation: { duration: 0 } })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      host.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      chart.off('brushEnd', onBrushEnd)
      chart.off('dataZoom', onDataZoom)
      chartRef.current = null
      if (yAutorangeRafRef.current !== null) {
        window.cancelAnimationFrame(yAutorangeRafRef.current)
        yAutorangeRafRef.current = null
      }
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

    // Derive run start from the most recent entry's runtime so timestamps
    // reflect actual wall-clock positions (not assumed 1-second spacing).
    const lastLog = log.length > 0 ? log[log.length - 1] : null
    const runStartMs = lastLog ? now - lastLog.runtime * 1000 : now

    const actual: Point[] = []
    const target: Point[] = []

    for (let i = 0; i < log.length; i++) {
      const oven = log[i]
      const t = runStartMs + oven.runtime * 1000
      actual.push([t, Number.isFinite(oven.temperature) ? oven.temperature : null])
      target.push([t, isTargetAvailable(oven) ? oven.target : null])
    }

    actualRef.current = actual
    targetRef.current = target
    clampHistory(actualRef.current, maxPoints)
    clampHistory(targetRef.current, maxPoints)

    if (backlog.profile?.data) {
      scheduleRef.current = backlog.profile.data.map(
        ([sec, temp]) => [runStartMs + sec * 1000, temp] as Point,
      )
    } else {
      scheduleRef.current = []
    }

    lastPointAtRef.current = now
    seededRef.current = true

    chartRef.current.setOption(
      {
        series: [{ data: actualRef.current }, { data: targetRef.current }, { data: scheduleRef.current }],
      },
      { notMerge: false, lazyUpdate: true },
    )

    scheduleYAxisAutorange(chartRef.current)

    // Start in the correct zoom state immediately after seeding.
    if (followLiveRef.current && autoLiveWindowRef.current) {
      applyAutoLiveWindow(chartRef.current)
    }
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

    // Skip chart updates while the user is dragging on the chart (slider bar,
    // brush selection). setOption() during a drag interrupts ECharts' internal
    // state. Data accumulates in refs and gets flushed when the pointer is released.
    if (pointerDownRef.current) return

    // Update just series data; keep config stable.
    chart.setOption(
      {
        series: [{ data: actualRef.current }, { data: targetRef.current }, { data: scheduleRef.current }],
      },
      { notMerge: false, lazyUpdate: true },
    )

    scheduleYAxisAutorange(chart)

    if (followLiveRef.current) {
      if (autoLiveWindowRef.current) {
        applyAutoLiveWindow(chart)
      } else {
        // Preserve current zoom level; pin it to the live edge.
        const win = readZoomWindowPct(chart)
        if (win) {
          const span = Math.max(0, Math.min(100, win.endPct - win.startPct))
          if (span > 0) zoomSpanPctRef.current = span
        }

        const ext = timeExtent()
        if (ext && ext.max > ext.min) {
          const spanMs = (zoomSpanPctRef.current / 100) * (ext.max - ext.min)
          const ev = ext.max
          const sv = Math.max(ext.min, ev - spanMs)

          programmaticZoomRef.current = true
          chart.setOption(
            {
              dataZoom: [
                { rangeMode: ['value', 'value'], startValue: sv, endValue: ev },
                { rangeMode: ['value', 'value'], startValue: sv, endValue: ev },
              ],
            },
            { notMerge: false, lazyUpdate: true },
          )
          window.setTimeout(() => {
            programmaticZoomRef.current = false
          }, 0)
        }
      }
    }
    // When followLive is false, ECharts preserves the value-based zoom position
    // naturally as new data is added (filterMode: 'none' + merge mode).
  }, [props.state, maxPoints])

  useEffect(() => {
    return () => {
      if (zoomSpanHideTimerRef.current !== null) {
        window.clearTimeout(zoomSpanHideTimerRef.current)
        zoomSpanHideTimerRef.current = null
      }
    }
  }, [])

  return (
    <div className="liveChartWrap" aria-label="Live temperature chart">
      {!followLive || !autoLiveWindow ? (
        <button type="button" className="chartReset" onClick={resetToLive} aria-label="Reset chart to live view">
          Reset Zoom
        </button>
      ) : null}
      {zoomSpanLabel ? <div className="chartZoomSpan" aria-live="polite">{zoomSpanLabel}</div> : null}
      <div ref={hostRef} className="liveChart" />
    </div>
  )
}
