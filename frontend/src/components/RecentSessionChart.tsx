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

function fmtAxisTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
  useEffect(() => {
    unitRef.current = unit
  }, [unit])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart

    const base = {
      animation: false,
      grid: { left: 44, right: 14, top: 34, bottom: 54 },
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
        valueFormatter: (v: unknown) => {
          const u = unitRef.current
          return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}°${u}` : '--'
        },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', start: 0, end: 100 },
        {
          type: 'slider',
          xAxisIndex: 0,
          start: 0,
          end: 100,
          height: 18,
          bottom: 10,
          backgroundColor: 'rgba(255,255,255,0.06)',
          borderColor: 'rgba(255,255,255,0.14)',
          fillerColor: 'rgba(180, 200, 220, 0.14)',
          handleStyle: { color: 'rgba(180, 200, 220, 0.52)', borderColor: 'rgba(180, 200, 220, 0.28)' },
          textStyle: { color: 'rgba(255,255,255,0.70)' },
        },
      ],
      xAxis: {
        type: 'time',
        minInterval: 60_000,
        axisLabel: {
          color: 'rgba(255,255,255,0.70)',
          formatter: (v: number) => fmtAxisTime(v),
          hideOverlap: true,
        },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.16)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      },
      yAxis: {
        type: 'value',
        boundaryGap: ['10%', '10%'],
        axisLabel: {
          color: 'rgba(255,255,255,0.70)',
          formatter: (v: number) => {
            const u = unitRef.current
            return Number.isFinite(v) ? `${Math.round(v)}°${u}` : '--'
          },
        },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.16)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      },
      series: [
        {
          name: 'Actual (profile)',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: 'rgba(75, 160, 255, 0.95)' },
          lineStyle: { width: 2, color: 'rgba(75, 160, 255, 0.95)' },
          sampling: 'lttb',
        },
        {
          name: 'Cooldown tail',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: 'rgba(184, 198, 214, 0.92)' },
          lineStyle: { width: 2, color: 'rgba(184, 198, 214, 0.92)' },
          sampling: 'lttb',
        },
        {
          name: 'Target',
          type: 'line',
          showSymbol: false,
          data: [] as Point[],
          itemStyle: { color: 'rgba(240, 176, 74, 0.95)' },
          lineStyle: { width: 2, type: 'dashed', color: 'rgba(240, 176, 74, 0.95)' },
          sampling: 'lttb',
        },
      ],
    }

    chart.setOption(base, { notMerge: true })

    const ro = new ResizeObserver(() => {
      chart.resize({ animation: { duration: 0 } })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      chartRef.current = null
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
                    lineStyle: { color: 'rgba(240, 176, 74, 0.85)', width: 2, type: 'solid' },
                    label: {
                      show: true,
                      formatter: endedLabel,
                      color: 'rgba(240, 176, 74, 0.92)',
                      fontWeight: 800,
                      padding: [2, 6, 2, 6],
                      backgroundColor: 'rgba(12, 18, 28, 0.65)',
                      borderColor: 'rgba(240, 176, 74, 0.25)',
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
                    itemStyle: { color: 'rgba(184, 198, 214, 0.08)' },
                    label: {
                      show: true,
                      color: 'rgba(184, 198, 214, 0.78)',
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
      {error ? <p className="muted">Session chart error: {error}</p> : null}
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
