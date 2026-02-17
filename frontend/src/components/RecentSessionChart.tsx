import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  BrushComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType } from 'echarts/core'
import { apiGetSession, apiListSessionSamples, apiListSessions } from '../api/sessions'
import type { Session, SessionSample } from '../contract/sessions'
import { extractTemp, extractTarget } from '../util/sampleExtract'

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  BrushComponent,
  CanvasRenderer,
])

type Point = [number, number | null]

type RecentSessionChartProps = {
  tempScale: 'f' | 'c' | null
  theme?: 'stoneware' | 'dark'
}

type ChartScheme = {
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

  seriesActual: string
  seriesTarget: string
  seriesSchedule: string
  seriesTail: string

  markerLine: string
  markerLabelBg: string
  markerLabelBorder: string
  tailShade: string
  tailLabel: string
}

function schemeForTheme(theme: 'stoneware' | 'dark'): ChartScheme {
  if (theme === 'stoneware') {
    return {
      text: 'rgba(45, 35, 28, 0.72)',
      textStrong: 'rgba(45, 35, 28, 0.92)',
      line: 'rgba(70, 55, 44, 0.22)',
      grid: 'rgba(70, 55, 44, 0.08)',
      tooltipBg: 'rgba(251, 248, 242, 0.98)',
      tooltipBorder: 'rgba(70, 55, 44, 0.16)',

      zoomBg: 'rgba(70, 55, 44, 0.04)',
      zoomBorder: 'rgba(70, 55, 44, 0.14)',
      zoomFill: 'rgba(138, 90, 68, 0.10)',
      zoomHandle: 'rgba(138, 90, 68, 0.40)',
      zoomHandleBorder: 'rgba(138, 90, 68, 0.22)',

      seriesActual: 'rgba(56, 109, 140, 0.95)',
      seriesTarget: 'rgba(138, 90, 68, 0.95)',
      seriesSchedule: 'rgba(90, 140, 90, 0.70)',
      seriesTail: 'rgba(143, 132, 121, 0.92)',

      markerLine: 'rgba(138, 90, 68, 0.85)',
      markerLabelBg: 'rgba(251, 248, 242, 0.92)',
      markerLabelBorder: 'rgba(138, 90, 68, 0.25)',
      tailShade: 'rgba(143, 132, 121, 0.10)',
      tailLabel: 'rgba(70, 55, 44, 0.62)',
    }
  }

  // dark
  return {
    text: 'rgba(255, 255, 255, 0.78)',
    textStrong: 'rgba(255, 255, 255, 0.92)',
    line: 'rgba(255, 255, 255, 0.16)',
    grid: 'rgba(255, 255, 255, 0.08)',
    tooltipBg: 'rgba(12, 18, 28, 0.92)',
    tooltipBorder: 'rgba(255, 255, 255, 0.14)',

    zoomBg: 'rgba(255, 255, 255, 0.06)',
    zoomBorder: 'rgba(255, 255, 255, 0.14)',
    zoomFill: 'rgba(180, 200, 220, 0.14)',
    zoomHandle: 'rgba(180, 200, 220, 0.52)',
    zoomHandleBorder: 'rgba(180, 200, 220, 0.28)',

    seriesActual: 'rgba(75, 160, 255, 0.95)',
    seriesTarget: 'rgba(240, 176, 74, 0.95)',
    seriesSchedule: 'rgba(120, 200, 120, 0.70)',
    seriesTail: 'rgba(184, 198, 214, 0.92)',

    markerLine: 'rgba(240, 176, 74, 0.85)',
    markerLabelBg: 'rgba(12, 18, 28, 0.72)',
    markerLabelBorder: 'rgba(240, 176, 74, 0.25)',
    tailShade: 'rgba(184, 198, 214, 0.08)',
    tailLabel: 'rgba(184, 198, 214, 0.78)',
  }
}

function fmtAxisTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtTemp(v: number): string {
  if (!Number.isFinite(v)) return '--'
  const rounded = Math.round(v)
  if (Math.abs(v - rounded) < 0.05) return String(rounded)
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

function fmtDateTime(tsSec: number | null): string {
  if (tsSec === null) return '--'
  const d = new Date(tsSec * 1000)
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function pickMostRecentCompleted(sessions: Session[]): Session | null {
  if (!sessions.length) return null
  const byCreated = [...sessions].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))

  const completed = byCreated.find((s) => s.outcome === 'COMPLETED' && typeof s.ended_at === 'number')
  if (completed) return completed
  const ended = byCreated.find((s) => typeof s.ended_at === 'number')
  if (ended) return ended
  return byCreated[0] ?? null
}


function dedupeByT(samples: SessionSample[]): SessionSample[] {
  const m = new Map<number, SessionSample>()
  for (const s of samples) {
    if (typeof s.t !== 'number' || !Number.isFinite(s.t)) continue
    m.set(s.t, s)
  }
  return [...m.values()].sort((a, b) => a.t - b.t)
}

export function RecentSessionChart(props: RecentSessionChartProps) {
  const theme = props.theme ?? 'stoneware'
  const scheme = useMemo(() => schemeForTheme(theme), [theme])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [samples, setSamples] = useState<SessionSample[]>([])
  const [scheduleRaw, setScheduleRaw] = useState<[number, number][] | null>(null)

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)

  const seriesDataRef = useRef<[Point[], Point[], Point[], Point[]]>([[], [], [], []])
  const timeExtentMsRef = useRef<{ min: number; max: number } | null>(null)
  const scheduleYAxisAutorangeRef = useRef<(() => void) | null>(null)
  const lastAppliedYRef = useRef<{ min: number; max: number } | null>(null)
  const yAutorangeRafRef = useRef<number | null>(null)
  useEffect(() => {
    unitRef.current = unit
  }, [unit])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart

    const readZoomWindowValues = (): { startValue: number; endValue: number } | null => {
      const opt = chart.getOption()
      const zoom0 = Array.isArray(opt.dataZoom) ? (opt.dataZoom[0] as Record<string, unknown> | undefined) : undefined
      if (!zoom0) return null

      const startValue = typeof zoom0.startValue === 'number' ? zoom0.startValue : null
      const endValue = typeof zoom0.endValue === 'number' ? zoom0.endValue : null
      if (startValue !== null && endValue !== null) return { startValue, endValue }

      const start = typeof zoom0.start === 'number' ? zoom0.start : null
      const end = typeof zoom0.end === 'number' ? zoom0.end : null
      if (start === null || end === null) return null
      const extent = timeExtentMsRef.current
      if (!extent) return null
      const min = extent.min
      const max = extent.max
      if (!(max > min)) return null
      const toValue = (pct: number) => min + ((max - min) * pct) / 100
      return { startValue: toValue(start), endValue: toValue(end) }
    }

    const computeVisibleYRange = (): { min: number; max: number } | null => {
      const win = readZoomWindowValues()
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

      const [s0, s1, s2, s3] = seriesDataRef.current
      scan(s0)
      scan(s1)
      scan(s2)
      scanInterpolated(s3)

      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null
      let span = maxY - minY
      if (!(span > 0)) span = 1
      const pad = Math.max(1, span * 0.08)
      const min = minY - pad
      const max = maxY + pad
      if (max - min < 2) {
        const mid = (max + min) / 2
        return { min: mid - 1, max: mid + 1 }
      }
      return { min, max }
    }

    const scheduleYAxisAutorange = () => {
      if (yAutorangeRafRef.current !== null) return
      yAutorangeRafRef.current = window.requestAnimationFrame(() => {
        yAutorangeRafRef.current = null
        const next = computeVisibleYRange()
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

    scheduleYAxisAutorangeRef.current = scheduleYAxisAutorange

    const base = {
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
          start: 0,
          end: 100,
          // Trackpad/two-finger scroll should pan, not zoom.
          zoomOnMouseWheel: 'ctrl',
          moveOnMouseWheel: true,
        },
        {
          type: 'slider',
          xAxisIndex: 0,
          start: 0,
          end: 100,
          height: 18,
          bottom: 10,
          backgroundColor: scheme.zoomBg,
          borderColor: scheme.zoomBorder,
          fillerColor: scheme.zoomFill,
          handleStyle: { color: scheme.zoomHandle, borderColor: scheme.zoomHandleBorder },
          textStyle: { color: scheme.text },
          zoomOnMouseWheel: 'ctrl',
          moveOnMouseWheel: true,
        },
      ],
      xAxis: {
        type: 'time',
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
          name: 'Actual (profile)',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: scheme.seriesActual },
          lineStyle: { width: 2, color: scheme.seriesActual },
          sampling: 'lttb',
        },
        {
          name: 'Cooldown tail',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: scheme.seriesTail },
          lineStyle: { width: 2, color: scheme.seriesTail },
          sampling: 'lttb',
        },
        {
          name: 'Target',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: scheme.seriesTarget },
          lineStyle: { width: 2, type: 'dashed', color: scheme.seriesTarget },
          sampling: 'lttb',
        },
        {
          name: 'Schedule',
          type: 'line',
          z: 1,
          showSymbol: true,
          symbolSize: 6,
          symbol: 'circle',
          data: [] as Point[],
          itemStyle: { color: scheme.seriesSchedule },
          lineStyle: { width: 1.5, type: 'dotted', color: scheme.seriesSchedule },
        },
      ],
    }

    chart.setOption(base, { notMerge: true })

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
      chart.setOption(
        {
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue, endValue },
            { rangeMode: ['value', 'value'], startValue, endValue },
          ],
        },
        { notMerge: false, lazyUpdate: true },
      )

      scheduleYAxisAutorange()

      // Re-activate brush so the next drag works immediately.
      activateBrush()
    }
    chart.on('brushEnd', onBrushEnd)

    const onDataZoom = () => {
      scheduleYAxisAutorange()
    }

    chart.on('dataZoom', onDataZoom)

    const ro = new ResizeObserver(() => {
      chart.resize({ animation: { duration: 0 } })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      chart.off('brushEnd', onBrushEnd)
      chart.off('dataZoom', onDataZoom)
      chartRef.current = null
      scheduleYAxisAutorangeRef.current = null
      if (yAutorangeRafRef.current !== null) {
        window.cancelAnimationFrame(yAutorangeRafRef.current)
        yAutorangeRafRef.current = null
      }
      chart.dispose()
    }
  }, [scheme])

  useEffect(() => {
    const ac = new AbortController()

    const run = async () => {
      setLoading(true)
      setError(null)
      setSession(null)
      setSamples([])

      const sessRes = await apiListSessions({ limit: 10, offset: 0, signal: ac.signal })
      if (!sessRes.ok) {
        setError(sessRes.error)
        setLoading(false)
        return
      }

      const picked = pickMostRecentCompleted(sessRes.value)
      if (!picked) {
        setError('No sessions found')
        setLoading(false)
        return
      }

      setSession(picked)

      // Fetch full session detail (includes schedule from meta_json).
      const detailRes = await apiGetSession({ sessionId: picked.id, signal: ac.signal })
      if (detailRes.ok && detailRes.value.schedule) {
        setScheduleRaw(detailRes.value.schedule)
      }

      // Fetch a bounded window around profile end.
      // Goal: clearly show a tail beyond end-of-profile without pulling an entire multi-hour session.
      const endedAt = typeof picked.ended_at === 'number' ? picked.ended_at : null
      const startedAt = typeof picked.started_at === 'number' ? picked.started_at : null

      const all: SessionSample[] = []
      const LIMIT = 5000

      if (endedAt !== null) {
        const pre = 60 * 60
        const fromPre = startedAt !== null ? Math.max(startedAt, endedAt - pre) : Math.max(0, endedAt - pre)

        const preRes = await apiListSessionSamples({
          sessionId: picked.id,
          from: fromPre,
          to: endedAt,
          limit: LIMIT,
          signal: ac.signal,
        })
        if (!preRes.ok) {
          setError(preRes.error)
          setLoading(false)
          return
        }
        all.push(...preRes.value.samples)

        // Tail: fetch up to 4 hours after end in fixed-size chunks.
        const tailSeconds = 4 * 60 * 60
        const chunk = LIMIT
        for (let offset = 0; offset < tailSeconds; offset += chunk) {
          const from = endedAt + offset
          const to = Math.min(endedAt + tailSeconds, endedAt + offset + (chunk - 1))
          const tailRes = await apiListSessionSamples({
            sessionId: picked.id,
            from,
            to,
            limit: LIMIT,
            signal: ac.signal,
          })
          if (!tailRes.ok) {
            setError(tailRes.error)
            setLoading(false)
            return
          }
          if (tailRes.value.samples.length === 0) break
          all.push(...tailRes.value.samples)
          if (tailRes.value.samples.length < 10) break
        }
      } else {
        // Running or missing ended_at: best-effort small window.
        const from = startedAt !== null ? startedAt : null
        const res = await apiListSessionSamples({ sessionId: picked.id, from, to: null, limit: LIMIT, signal: ac.signal })
        if (!res.ok) {
          setError(res.error)
          setLoading(false)
          return
        }
        all.push(...res.value.samples)
      }

      setSamples(dedupeByT(all))
      setLoading(false)
    }

    run().catch((e) => {
      if (String(e).includes('AbortError')) return
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    })

    return () => {
      ac.abort()
    }
  }, [])

  const chartPoints = useMemo(() => {
    const startedAtSec = session && typeof session.started_at === 'number' ? session.started_at : null
    const endedAt = session && typeof session.ended_at === 'number' ? session.ended_at : null
    const endMs = endedAt !== null ? endedAt * 1000 : null

    const actualProfile: Point[] = []
    const actualCooldown: Point[] = []
    const target: Point[] = []

    for (const s of samples) {
      const tMs = s.t * 1000
      const temp = extractTemp(s.state)
      const tgt = extractTarget(s.state)

      if (endMs !== null && tMs > endMs) {
        actualCooldown.push([tMs, temp])
        target.push([tMs, null])
      } else {
        actualProfile.push([tMs, temp])
        target.push([tMs, tgt])
        actualCooldown.push([tMs, null])
      }
    }

    const schedule: Point[] = []
    if (scheduleRaw && startedAtSec !== null) {
      for (const [sec, temp] of scheduleRaw) {
        schedule.push([startedAtSec * 1000 + sec * 1000, temp])
      }
    }

    return { actualProfile, actualCooldown, target, schedule, endMs }
  }, [samples, session, scheduleRaw])

  useEffect(() => {
    seriesDataRef.current = [chartPoints.actualProfile, chartPoints.actualCooldown, chartPoints.target, chartPoints.schedule]
    const firstMs = samples.length ? samples[0]!.t * 1000 : null
    const lastMs = samples.length ? samples[samples.length - 1]!.t * 1000 : null
    timeExtentMsRef.current = firstMs !== null && lastMs !== null && lastMs > firstMs ? { min: firstMs, max: lastMs } : null

    // Anchor zoom to sample extent so schedule data doesn't expand the initial view.
    const ext = timeExtentMsRef.current
    if (ext && chartRef.current) {
      chartRef.current.setOption(
        {
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
            { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
          ],
        },
        { notMerge: false, lazyUpdate: true },
      )
    }

    // Re-fit y-axis when data changes (initial load / session switch).
    lastAppliedYRef.current = null
    scheduleYAxisAutorangeRef.current?.()
  }, [chartPoints, samples])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const endMs = chartPoints.endMs
    const maxMs = samples.length ? samples[samples.length - 1]!.t * 1000 : null
    const markArea = endMs !== null && maxMs !== null && maxMs > endMs
    const hasTail = chartPoints.actualCooldown.some((p) => p[1] !== null)

    const endState = session?.ended_at ? 'ended' : session?.outcome ?? null
    const endedLabel = endMs !== null ? 'Profile end' : null

    chart.setOption(
      {
        series: [
          {
            data: chartPoints.actualProfile,
            markLine:
              endMs !== null
                ? {
                    silent: true,
                    symbol: ['none', 'none'],
                    lineStyle: { color: scheme.markerLine, width: 2, type: 'solid' },
                    label: {
                      show: true,
                      formatter: endedLabel,
                      color: scheme.markerLine,
                      fontWeight: 800,
                      padding: [2, 6, 2, 6],
                      backgroundColor: scheme.markerLabelBg,
                      borderColor: scheme.markerLabelBorder,
                      borderWidth: 1,
                      borderRadius: 8,
                    },
                    data: [{ xAxis: endMs }],
                  }
                : undefined,
          },
          {
            data: chartPoints.actualCooldown,
            lineStyle: { width: 2, type: hasTail ? 'solid' : 'dotted' },
            markArea:
              markArea
                ? {
                    silent: true,
                    itemStyle: { color: scheme.tailShade },
                    label: {
                      show: true,
                      color: scheme.tailLabel,
                      fontWeight: 800,
                      formatter: 'Cooldown tail',
                      position: 'insideTop',
                    },
                    data: [[{ xAxis: endMs }, { xAxis: maxMs }]],
                  }
                : undefined,
          },
          {
            data: chartPoints.target,
          },
          {
            data: chartPoints.schedule,
          },
        ],
        title: {
          show: false,
          text: endState ? String(endState) : undefined,
        },
      },
      { notMerge: false, lazyUpdate: true },
    )
  }, [chartPoints, samples, session, scheme])

  const endedAt = session && typeof session.ended_at === 'number' ? session.ended_at : null
  const startedAt = session && typeof session.started_at === 'number' ? session.started_at : null

  const cooldownSamples = useMemo(() => {
    if (!endedAt) return 0
    return samples.filter((s) => s.t > endedAt && extractTemp(s.state) !== null).length
  }, [samples, endedAt])

  const profileSamples = useMemo(() => {
    if (!endedAt) return samples.length
    return samples.filter((s) => s.t <= endedAt && extractTemp(s.state) !== null).length
  }, [samples, endedAt])

  const endedState = session?.outcome ?? '--'

  const endpointHint = useMemo(() => {
    if (!error) return null
    if (error.includes('HTTP_404') || error.includes('Expected JSON')) {
      return `Try: curl ${window.location.origin}/v1/sessions`
    }
    return null
  }, [error])

  return (
    <div className="recentSession" aria-label="Most recent session">
      <div className="recentSessionMeta">
        <div className="kv compact">
          <div className="k">Profile</div>
          <div className="v">{session?.profile_name ?? '--'}</div>
        </div>
        <div className="kv compact">
          <div className="k">Outcome</div>
          <div className="v">{endedState}</div>
        </div>
        <div className="kv compact">
          <div className="k">Start</div>
          <div className="v">{fmtDateTime(startedAt)}</div>
        </div>
        <div className="kv compact">
          <div className="k">End</div>
          <div className="v">{fmtDateTime(endedAt)}</div>
        </div>
        <div className="kv compact">
          <div className="k">Samples</div>
          <div className="v">
            {samples.length ? `${profileSamples} profile + ${cooldownSamples} tail` : '--'}
          </div>
        </div>
        <div className="kv compact">
          <div className="k">Unit</div>
          <div className="v">°{unit || '--'}</div>
        </div>
      </div>

      {loading ? <p className="muted">Loading most recent session…</p> : null}
      {error ? (
        <p className="muted">
          Session chart error: {error}
          {endpointHint ? (
            <>
              <br />
              <span className="muted">{endpointHint}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {!loading && !error && !samples.length ? <p className="muted">No samples available for this session.</p> : null}

      <div className="liveChartWrap" aria-label="Session temperature chart">
        <div ref={hostRef} className="liveChart sessionChart" />
      </div>

      <p className="muted chartHint">
        End-of-profile is marked; shaded region indicates the cooldown tail beyond the profile.
      </p>
      {session && typeof session.ended_at !== 'number' ? (
        <p className="muted">Note: this session has no end timestamp yet; cooldown tail marker is unavailable.</p>
      ) : null}
      {session && session.outcome !== 'COMPLETED' ? (
        <p className="muted">Note: cooldown tail sampling is only expected for COMPLETED runs.</p>
      ) : null}
      {session && !loading && !error ? (
        <p className="muted">
          Session id: <code>{session.id}</code>
        </p>
      ) : null}
    </div>
  )
}
