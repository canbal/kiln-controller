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
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType } from 'echarts/core'
import { apiListSessionSamples, apiListSessions } from '../api/sessions'
import type { Session, SessionSample } from '../contract/sessions'

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
])

type Point = [number, number | null]

type RecentSessionChartProps = {
  tempScale: 'f' | 'c' | null
}

const CHART_TEXT = 'rgba(58, 40, 27, 0.72)'
const CHART_TEXT_STRONG = 'rgba(58, 40, 27, 0.92)'
const CHART_LINE = 'rgba(90, 64, 44, 0.22)'
const CHART_GRID = 'rgba(90, 64, 44, 0.08)'
const CHART_TOOLTIP_BG = 'rgba(255, 253, 248, 0.98)'
const CHART_TOOLTIP_BORDER = 'rgba(90, 64, 44, 0.16)'

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

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function extractTemp(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null
  const v = (state as Record<string, unknown>).temperature
  return isFiniteNumber(v) ? v : null
}

function extractTarget(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null
  const s = (state as Record<string, unknown>).state
  const v = (state as Record<string, unknown>).target
  if (s !== 'RUNNING') return null
  return isFiniteNumber(v) && v > 0 ? v : null
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
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [samples, setSamples] = useState<SessionSample[]>([])

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)

  const seriesDataRef = useRef<[Point[], Point[], Point[]]>([[], [], []])
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

      const [s0, s1, s2] = seriesDataRef.current
      scan(s0)
      scan(s1)
      scan(s2)

      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null
      let span = maxY - minY
      if (!(span > 0)) span = 1
      const pad = Math.max(1, span * 0.08)
      const min = Math.max(0, minY - pad)
      const max = maxY + pad
      if (max - min < 2) {
        const mid = (max + min) / 2
        return { min: Math.max(0, mid - 1), max: mid + 1 }
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
      grid: { left: 44, right: 14, top: 34, bottom: 54 },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: CHART_TEXT, fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: CHART_TOOLTIP_BG,
        borderColor: CHART_TOOLTIP_BORDER,
        textStyle: { color: CHART_TEXT_STRONG },
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
          backgroundColor: 'rgba(90, 64, 44, 0.04)',
          borderColor: 'rgba(90, 64, 44, 0.14)',
          fillerColor: 'rgba(197, 106, 45, 0.10)',
          handleStyle: { color: 'rgba(197, 106, 45, 0.40)', borderColor: 'rgba(197, 106, 45, 0.22)' },
          textStyle: { color: CHART_TEXT },
          zoomOnMouseWheel: 'ctrl',
          moveOnMouseWheel: true,
        },
      ],
      xAxis: {
        type: 'time',
        minInterval: 60_000,
        axisLabel: {
          color: CHART_TEXT,
          formatter: (v: number) => fmtAxisTime(v),
          hideOverlap: true,
        },
        axisLine: { lineStyle: { color: CHART_LINE } },
        splitLine: { lineStyle: { color: CHART_GRID } },
      },
      yAxis: {
        type: 'value',
        boundaryGap: ['10%', '10%'],
        minInterval: 0.5,
        axisLabel: {
          color: CHART_TEXT,
          formatter: (v: number) => {
            const u = unitRef.current
            return Number.isFinite(v) ? `${fmtTemp(v)}°${u}` : '--'
          },
        },
        axisLine: { lineStyle: { color: CHART_LINE } },
        splitLine: { lineStyle: { color: CHART_GRID } },
      },
      series: [
        {
          name: 'Actual (profile)',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: 'rgba(56, 109, 140, 0.95)' },
          lineStyle: { width: 2, color: 'rgba(56, 109, 140, 0.95)' },
          sampling: 'lttb',
        },
        {
          name: 'Cooldown tail',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: 'rgba(158, 141, 126, 0.92)' },
          lineStyle: { width: 2, color: 'rgba(158, 141, 126, 0.92)' },
          sampling: 'lttb',
        },
        {
          name: 'Target',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: 'rgba(197, 106, 45, 0.95)' },
          lineStyle: { width: 2, type: 'dashed', color: 'rgba(197, 106, 45, 0.95)' },
          sampling: 'lttb',
        },
      ],
    }

    chart.setOption(base, { notMerge: true })

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
      chart.off('dataZoom', onDataZoom)
      chartRef.current = null
      scheduleYAxisAutorangeRef.current = null
      if (yAutorangeRafRef.current !== null) {
        window.cancelAnimationFrame(yAutorangeRafRef.current)
        yAutorangeRafRef.current = null
      }
      chart.dispose()
    }
  }, [])

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

    return { actualProfile, actualCooldown, target, endMs }
  }, [samples, session])

  useEffect(() => {
    seriesDataRef.current = [chartPoints.actualProfile, chartPoints.actualCooldown, chartPoints.target]
    const firstMs = samples.length ? samples[0]!.t * 1000 : null
    const lastMs = samples.length ? samples[samples.length - 1]!.t * 1000 : null
    timeExtentMsRef.current = firstMs !== null && lastMs !== null && lastMs > firstMs ? { min: firstMs, max: lastMs } : null

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
                    lineStyle: { color: 'rgba(197, 106, 45, 0.85)', width: 2, type: 'solid' },
                    label: {
                      show: true,
                      formatter: endedLabel,
                      color: 'rgba(197, 106, 45, 0.92)',
                      fontWeight: 800,
                      padding: [2, 6, 2, 6],
                      backgroundColor: 'rgba(255, 253, 248, 0.92)',
                      borderColor: 'rgba(197, 106, 45, 0.25)',
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
                    itemStyle: { color: 'rgba(158, 141, 126, 0.10)' },
                    label: {
                      show: true,
                      color: 'rgba(90, 64, 44, 0.62)',
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
        ],
        title: {
          show: false,
          text: endState ? String(endState) : undefined,
        },
      },
      { notMerge: false, lazyUpdate: true },
    )
  }, [chartPoints, samples, session])

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
