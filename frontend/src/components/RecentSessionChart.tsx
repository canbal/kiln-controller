import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import { apiGetSession, apiListSessions } from '../api/sessions'
import type { Session } from '../contract/sessions'
import { extractTemp, extractTarget } from '../util/sampleExtract'
import { fetchAllSessionSamples } from '../util/fetchSessionSamples'
import type { Point } from '../util/chartFormatting'
import { fmtTemp, fmtAxisTime } from '../util/chartFormatting'
import { schemeForTheme } from '../util/chartTheme'
import { setupChart, resetYAxisCache } from '../util/chartSetup'

type RecentSessionChartProps = {
  tempScale: 'f' | 'c' | null
  theme?: 'stoneware' | 'dark'
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

export function RecentSessionChart(props: RecentSessionChartProps) {
  const theme = props.theme ?? 'stoneware'
  const scheme = useMemo(() => schemeForTheme(theme), [theme])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const setupRef = useRef<ReturnType<typeof setupChart> | null>(null)
  const programmaticZoomRef = useRef(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  // Sample data stored in state for rendering metadata; refs for chart updates.
  const [sampleCount, setSampleCount] = useState(0)
  const [profileSampleCount, setProfileSampleCount] = useState(0)
  const [cooldownSampleCount, setCooldownSampleCount] = useState(0)

  const seriesDataRef = useRef<[Point[], Point[], Point[], Point[]]>([[], [], [], []])
  const timeExtentMsRef = useRef<{ min: number; max: number } | null>(null)

  const [zoomSpanLabel, setZoomSpanLabel] = useState<string | null>(null)
  const zoomSpanHideTimerRef = useRef<number | null>(null)
  const [zoomed, setZoomed] = useState(false)

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)
  useEffect(() => {
    unitRef.current = unit
  }, [unit])

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

  const resetZoom = () => {
    const chart = chartRef.current
    if (!chart) return
    const ext = timeExtentMsRef.current
    if (ext) {
      programmaticZoomRef.current = true
      chart.setOption(
        {
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
            { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
          ],
        },
        { notMerge: false, lazyUpdate: true },
      )
      window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
    } else {
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
    }
    setZoomed(false)
  }

  // --- Chart init effect ---
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const baseOption = {
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

    const onManualZoom = () => {
      setZoomed(true)
      showZoomSpanHint()
    }

    const result = setupChart(
      host,
      baseOption,
      {
        onManualZoom,
        getDataExtent: () => timeExtentMsRef.current,
        getSeriesForYRange: () => {
          const [s0, s1, s2, s3] = seriesDataRef.current
          return { scan: [s0, s1, s2], interpolate: [s3] }
        },
        minZoomMs: 10_000,
      },
      programmaticZoomRef,
    )

    chartRef.current = result.chart
    setupRef.current = result

    return () => {
      result.destroy()
      chartRef.current = null
      setupRef.current = null
      if (zoomSpanHideTimerRef.current !== null) {
        window.clearTimeout(zoomSpanHideTimerRef.current)
        zoomSpanHideTimerRef.current = null
      }
    }
  }, [scheme])

  // --- Data fetch effect ---
  useEffect(() => {
    const ac = new AbortController()

    const run = async () => {
      setLoading(true)
      setError(null)
      setSession(null)

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

      // Fetch all samples (paginated).
      const startedAt = typeof picked.started_at === 'number' ? picked.started_at : undefined
      const samples = await fetchAllSessionSamples({
        sessionId: picked.id,
        from: startedAt,
        signal: ac.signal,
      })

      // Build chart data.
      const startedAtSec = typeof picked.started_at === 'number' ? picked.started_at : null
      const endedAt = typeof picked.ended_at === 'number' ? picked.ended_at : null
      const endMs = endedAt !== null ? endedAt * 1000 : null

      const actualProfile: Point[] = []
      const actualCooldown: Point[] = []
      const target: Point[] = []
      let profileCount = 0
      let cooldownCount = 0

      for (const s of samples) {
        const tMs = s.t * 1000
        const temp = extractTemp(s.state)
        const tgt = extractTarget(s.state)

        if (endMs !== null && tMs > endMs) {
          actualCooldown.push([tMs, temp])
          target.push([tMs, null])
          if (temp !== null) cooldownCount++
        } else {
          actualProfile.push([tMs, temp])
          target.push([tMs, tgt])
          actualCooldown.push([tMs, null])
          if (temp !== null) profileCount++
        }
      }

      let scheduleFromDetail: [number, number][] | null = null
      if (detailRes.ok && detailRes.value.schedule) {
        scheduleFromDetail = detailRes.value.schedule
      }

      const schedule: Point[] = []
      const sched = scheduleFromDetail
      if (sched && startedAtSec !== null) {
        for (const [sec, temp] of sched) {
          schedule.push([startedAtSec * 1000 + sec * 1000, temp])
        }
      }

      setSampleCount(samples.length)
      setProfileSampleCount(profileCount)
      setCooldownSampleCount(cooldownCount)

      // Store in refs for chart updates.
      seriesDataRef.current = [actualProfile, actualCooldown, target, schedule]

      const firstMs = samples.length ? samples[0].t * 1000 : null
      const lastMs = samples.length ? samples[samples.length - 1].t * 1000 : null
      timeExtentMsRef.current = firstMs !== null && lastMs !== null && lastMs > firstMs ? { min: firstMs, max: lastMs } : null

      // Update chart.
      const chart = chartRef.current
      const setup = setupRef.current
      if (chart && setup) {
        const hasTail = actualCooldown.some((p) => p[1] !== null)
        const maxMs = samples.length ? samples[samples.length - 1].t * 1000 : null
        const markArea = endMs !== null && maxMs !== null && maxMs > endMs

        chart.setOption(
          {
            series: [
              {
                data: actualProfile,
                markLine:
                  endMs !== null
                    ? {
                        silent: true,
                        symbol: ['none', 'none'],
                        lineStyle: { color: scheme.markerLine, width: 2, type: 'solid' },
                        label: {
                          show: true,
                          formatter: 'Profile end',
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
                data: actualCooldown,
                lineStyle: { width: 2, type: hasTail ? 'solid' : 'dotted' },
                markArea: markArea
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
              { data: target },
              { data: schedule },
            ],
          },
          { notMerge: false, lazyUpdate: true },
        )

        // Anchor zoom to sample extent.
        const ext = timeExtentMsRef.current
        if (ext) {
          programmaticZoomRef.current = true
          chart.setOption(
            {
              dataZoom: [
                { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
                { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
              ],
            },
            { notMerge: false, lazyUpdate: true },
          )
          window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
        }

        resetYAxisCache(setup.scheduleYAxisAutorange)
        setup.scheduleYAxisAutorange()
      }

      setLoading(false)
    }

    run().catch((e) => {
      if (String(e).includes('AbortError')) return
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    })

    return () => { ac.abort() }
  }, [scheme])

  const endedAt = session && typeof session.ended_at === 'number' ? session.ended_at : null
  const startedAt = session && typeof session.started_at === 'number' ? session.started_at : null
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
            {sampleCount ? `${profileSampleCount} profile + ${cooldownSampleCount} tail` : '--'}
          </div>
        </div>
        <div className="kv compact">
          <div className="k">Unit</div>
          <div className="v">&deg;{unit || '--'}</div>
        </div>
      </div>

      {loading ? <p className="muted">Loading most recent session&hellip;</p> : null}
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
      {!loading && !error && !sampleCount ? <p className="muted">No samples available for this session.</p> : null}

      <div className="liveChartWrap" aria-label="Session temperature chart">
        {zoomed ? (
          <button type="button" className="chartReset" onClick={resetZoom} aria-label="Reset chart zoom">
            Reset Zoom
          </button>
        ) : null}
        {zoomSpanLabel ? <div className="chartZoomSpan" aria-live="polite">{zoomSpanLabel}</div> : null}
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
