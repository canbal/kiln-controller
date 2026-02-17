import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'
import { apiListSessions, apiGetSession } from '../api/sessions'
import { extractTemp, extractTarget } from '../util/sampleExtract'
import { fetchAllSessionSamples } from '../util/fetchSessionSamples'
import type { Point } from '../util/chartFormatting'
import { fmtTemp, fmtAxisTime } from '../util/chartFormatting'
import type { ChartScheme } from '../util/chartTheme'
import { schemeForTheme } from '../util/chartTheme'
import { readZoomWindowValues } from '../util/chartZoom'
import { setupChart } from '../util/chartSetup'

type LiveTempChartProps = {
  state: OvenState | null
  backlog: StatusBacklogEnvelope | null
  tempScale: 'f' | 'c' | null
  theme?: 'stoneware' | 'dark'
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

export function LiveTempChart(props: LiveTempChartProps) {
  const theme = props.theme ?? 'stoneware'
  const scheme = useMemo(() => schemeForTheme(theme), [theme])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const setupRef = useRef<ReturnType<typeof setupChart> | null>(null)

  const [followLive, setFollowLive] = useState(true)
  const followLiveRef = useRef(true)
  const [autoLiveWindow, setAutoLiveWindow] = useState(true)
  const programmaticZoomRef = useRef(false)
  const zoomSpanPctRef = useRef(20)

  const autoLiveWindowRef = useRef(true)

  const [zoomSpanLabel, setZoomSpanLabel] = useState<string | null>(null)
  const zoomSpanHideTimerRef = useRef<number | null>(null)

  const seededRef = useRef(false)
  const dbFetchPendingRef = useRef(false)
  const dbFetchDoneRef = useRef(false)
  const wsPendingBufferRef = useRef<OvenState[]>([])
  const runStartMsRef = useRef(0)
  const lastPointAtRef = useRef<number | null>(null)
  const actualRef = useRef<Point[]>([])
  const targetRef = useRef<Point[]>([])
  const scheduleRef = useRef<Point[]>([])
  const cooldownRef = useRef<Point[]>([])
  const profileEndMsRef = useRef<number | null>(null)
  const prevOvenStateRef = useRef<string | null>(null)

  const maxPoints = 2 * 60 * 60 // 2 hours at 1 Hz
  const LIVE_WINDOW_MS = 30 * 60 * 1000
  const MIN_ZOOM_MS = 10 * 1000

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)

  useEffect(() => {
    unitRef.current = unit
  }, [unit])

  // Extent of actual + cooldown data — used for live zoom logic.
  const timeExtent = () => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    const scanPts = (pts: Point[]) => {
      if (pts.length === 0) return
      const first = pts[0][0]
      const last = pts[pts.length - 1][0]
      if (Number.isFinite(first) && first < min) min = first
      if (Number.isFinite(last) && last > max) max = last
    }
    scanPts(actualRef.current)
    scanPts(cooldownRef.current)
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
    return { min, max }
  }

  // Extent of ALL series — matches ECharts' internal percentage space.
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
    update(cooldownRef.current)
    update(targetRef.current)
    update(scheduleRef.current)
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
    return { min, max }
  }

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

  const readZoomWindowPct = (chart: EChartsType): { startPct: number; endPct: number } | null => {
    const extent = timeExtent()
    if (!extent) return null
    const win = readZoomWindowValues(chart, chartDataExtent())
    if (!win) return null
    const toPct = (v: number) => ((v - extent.min) / (extent.max - extent.min)) * 100
    return {
      startPct: Math.max(0, Math.min(100, toPct(win.startValue))),
      endPct: Math.max(0, Math.min(100, toPct(win.endValue))),
    }
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
    window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
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
      window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
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
    window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
  }

  const buildMarkLine = (endMs: number, s: ChartScheme) => ({
    silent: true,
    symbol: ['none', 'none'],
    lineStyle: { color: s.markerLine, width: 2, type: 'solid' as const },
    label: {
      show: true,
      formatter: 'Profile end',
      color: s.markerLine,
      fontWeight: 800,
      padding: [2, 6, 2, 6],
      backgroundColor: s.markerLabelBg,
      borderColor: s.markerLabelBorder,
      borderWidth: 1,
      borderRadius: 8,
    },
    data: [{ xAxis: endMs }],
  })

  const buildMarkArea = (endMs: number, maxMs: number, s: ChartScheme) => ({
    silent: true,
    itemStyle: { color: s.tailShade },
    label: {
      show: true,
      color: s.tailLabel,
      fontWeight: 800,
      formatter: 'Cooldown tail',
      position: 'insideTop' as const,
    },
    data: [[{ xAxis: endMs }, { xAxis: maxMs }]],
  })

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
          name: 'Cooldown tail',
          type: 'line',
          showSymbol: false,
          itemStyle: { color: scheme.seriesTail },
          lineStyle: { width: 2, color: scheme.seriesTail },
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

  // --- Chart init effect ---
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const onManualZoom = () => {
      autoLiveWindowRef.current = false
      setAutoLiveWindow(false)
      followLiveRef.current = false
      setFollowLive(false)
      showZoomSpanHint()
    }

    const result = setupChart(
      host,
      baseOption,
      {
        onManualZoom,
        getDataExtent: chartDataExtent,
        getSeriesForYRange: () => ({
          scan: [actualRef.current, cooldownRef.current, targetRef.current],
          interpolate: [scheduleRef.current],
        }),
        minZoomMs: MIN_ZOOM_MS,
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

  // --- Helpers for 4-series setOption ---
  const setSeriesData = (chart: EChartsType) => {
    const endMs = profileEndMsRef.current
    const hasCooldown = cooldownRef.current.length > 0
    const cooldownMaxMs = hasCooldown ? cooldownRef.current[cooldownRef.current.length - 1][0] : null

    chart.setOption(
      {
        series: [
          {
            data: actualRef.current,
            markLine: endMs !== null ? buildMarkLine(endMs, scheme) : undefined,
          },
          {
            data: cooldownRef.current,
            markArea:
              endMs !== null && cooldownMaxMs !== null && cooldownMaxMs > endMs
                ? buildMarkArea(endMs, cooldownMaxMs, scheme)
                : undefined,
          },
          { data: targetRef.current },
          { data: scheduleRef.current },
        ],
      },
      { notMerge: false, lazyUpdate: true },
    )
  }

  // --- DB-seed effect ---
  useEffect(() => {
    const backlog = props.backlog
    if (!backlog) return
    if (seededRef.current || dbFetchPendingRef.current || dbFetchDoneRef.current) return
    if (!chartRef.current) return

    const lastLog = backlog.log.length > 0 ? backlog.log[backlog.log.length - 1] : null
    if (!lastLog) return

    // Attempt DB seed when oven is RUNNING, or when IDLE + cooldown_active.
    const isRunning = lastLog.state === 'RUNNING'
    const isCooldown = lastLog.state === 'IDLE' && lastLog.cooldown_active === true && typeof lastLog.cooldown_session_id === 'string'
    if (!isRunning && !isCooldown) return

    const ac = new AbortController()
    dbFetchPendingRef.current = true

    const run = async () => {
      let sessionId: string
      let startedAt: number

      if (isCooldown && lastLog.cooldown_session_id) {
        // Cooldown: fetch the session that just completed.
        sessionId = lastLog.cooldown_session_id
        const detailRes = await apiGetSession({ sessionId, signal: ac.signal })
        if (!detailRes.ok) throw new Error(detailRes.error)
        const session = detailRes.value
        startedAt = session.started_at ?? session.created_at

        // Build schedule from the completed session.
        const runStartMs = startedAt * 1000
        runStartMsRef.current = runStartMs

        let schedule: Point[] = []
        if (session.schedule && session.schedule.length > 0) {
          schedule = session.schedule.map(([sec, temp]) => [runStartMs + sec * 1000, temp] as Point)
        }
        scheduleRef.current = schedule

        // Record profile end.
        const endedAt = session.ended_at
        if (typeof endedAt === 'number') {
          profileEndMsRef.current = endedAt * 1000
        }

        // Fetch all samples and split at ended_at.
        const samples = await fetchAllSessionSamples({ sessionId, from: startedAt, signal: ac.signal })

        const actual: Point[] = []
        const target: Point[] = []
        const cooldown: Point[] = []

        const extractRuntime = (state: unknown): number | null => {
          if (!state || typeof state !== 'object') return null
          const v = (state as Record<string, unknown>).runtime
          return typeof v === 'number' && Number.isFinite(v) ? v : null
        }

        for (const s of samples) {
          const rt = extractRuntime(s.state)
          const tMs = rt !== null ? runStartMs + rt * 1000 : s.t * 1000

          if (typeof endedAt === 'number' && s.t > endedAt) {
            cooldown.push([tMs, extractTemp(s.state)])
          } else {
            actual.push([tMs, extractTemp(s.state)])
            target.push([tMs, extractTarget(s.state)])
          }
        }

        // Drain WS pending buffer for cooldown ticks.
        const buffered = wsPendingBufferRef.current
        wsPendingBufferRef.current = []
        for (const entry of buffered) {
          if (entry.state === 'IDLE' && entry.cooldown_active && typeof entry.cooldown_elapsed === 'number') {
            const endMs = profileEndMsRef.current ?? runStartMs
            const tMs = endMs + entry.cooldown_elapsed * 1000
            cooldown.push([tMs, Number.isFinite(entry.temperature) ? entry.temperature : null])
          }
        }

        clampHistory(actual, maxPoints)
        clampHistory(target, maxPoints)
        actualRef.current = actual
        targetRef.current = target
        cooldownRef.current = cooldown

      } else {
        // Running: standard DB seed.
        const listRes = await apiListSessions({ limit: 5, signal: ac.signal })
        if (!listRes.ok) throw new Error(listRes.error)
        const activeSession = listRes.value.find((s) => s.ended_at === null)
        if (!activeSession) throw new Error('no_active_session')

        sessionId = activeSession.id
        const detailRes2 = await apiGetSession({ sessionId, signal: ac.signal })
        if (!detailRes2.ok) throw new Error(detailRes2.error)
        const session2 = detailRes2.value

        startedAt = session2.started_at ?? session2.created_at
        const runStartMs = startedAt * 1000
        runStartMsRef.current = runStartMs

        const samples = await fetchAllSessionSamples({ sessionId, from: startedAt, signal: ac.signal })

        const extractRuntime = (state: unknown): number | null => {
          if (!state || typeof state !== 'object') return null
          const v = (state as Record<string, unknown>).runtime
          return typeof v === 'number' && Number.isFinite(v) ? v : null
        }

        const actual: Point[] = []
        const target: Point[] = []
        for (const s of samples) {
          const rt = extractRuntime(s.state)
          const tMs = rt !== null ? runStartMs + rt * 1000 : s.t * 1000
          actual.push([tMs, extractTemp(s.state)])
          target.push([tMs, extractTarget(s.state)])
        }

        let schedule: Point[] = []
        if (session2.schedule && session2.schedule.length > 0) {
          schedule = session2.schedule.map(([sec, temp]) => [runStartMs + sec * 1000, temp] as Point)
        } else if (backlog.profile?.data) {
          schedule = backlog.profile.data.map(([sec, temp]) => [runStartMs + sec * 1000, temp] as Point)
        }

        // Drain the WS pending buffer.
        const lastDbRuntimeMs = actual.length > 0 ? actual[actual.length - 1][0] : runStartMs
        const buffered = wsPendingBufferRef.current
        wsPendingBufferRef.current = []
        for (const entry of buffered) {
          const entryT = runStartMs + entry.runtime * 1000
          if (entryT <= lastDbRuntimeMs) continue
          actual.push([entryT, Number.isFinite(entry.temperature) ? entry.temperature : null])
          target.push([entryT, isTargetAvailable(entry) ? entry.target : null])
        }

        clampHistory(actual, maxPoints)
        clampHistory(target, maxPoints)
        actualRef.current = actual
        targetRef.current = target
        scheduleRef.current = schedule
      }

      // Seed the chart.
      const chart = chartRef.current
      if (!chart) return

      lastPointAtRef.current = Date.now()
      setSeriesData(chart)
      setupRef.current?.scheduleYAxisAutorange()

      if (followLiveRef.current && autoLiveWindowRef.current) {
        applyAutoLiveWindow(chart)
      }

      seededRef.current = true
      dbFetchDoneRef.current = true
      dbFetchPendingRef.current = false
    }

    run().catch((err) => {
      if (!ac.signal.aborted) {
        console.warn('[LiveTempChart] DB seed failed, falling back to backlog:', err)
      }
      dbFetchPendingRef.current = false
      wsPendingBufferRef.current = []
    })

    return () => { ac.abort() }
  }, [props.backlog, maxPoints, scheme])

  // --- Backlog-seed effect (fallback) ---
  useEffect(() => {
    const backlog = props.backlog
    if (!backlog) return
    if (seededRef.current) return
    if (dbFetchPendingRef.current || dbFetchDoneRef.current) return
    if (!chartRef.current) return

    const now = Date.now()
    const log = backlog.log
    const lastLog = log.length > 0 ? log[log.length - 1] : null
    const runStartMs = lastLog ? now - lastLog.runtime * 1000 : now
    runStartMsRef.current = runStartMs

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

    const chart = chartRef.current
    setSeriesData(chart)
    setupRef.current?.scheduleYAxisAutorange()

    if (followLiveRef.current && autoLiveWindowRef.current) {
      applyAutoLiveWindow(chart)
    }
  }, [props.backlog, maxPoints, scheme])

  // --- Live tick effect ---
  useEffect(() => {
    const oven = props.state
    const chart = chartRef.current
    const setup = setupRef.current
    if (!oven || !chart || !setup) return

    // Buffer while DB fetch is in flight.
    if (dbFetchPendingRef.current) {
      wsPendingBufferRef.current.push(oven)
      return
    }

    const now = Date.now()
    const lastAt = lastPointAtRef.current
    if (lastAt !== null && now - lastAt < 250) return
    lastPointAtRef.current = now

    // Detect RUNNING→IDLE transition.
    const prevState = prevOvenStateRef.current
    prevOvenStateRef.current = oven.state

    if (prevState === 'RUNNING' && oven.state === 'IDLE') {
      // Profile just ended — record the end timestamp.
      const lastActual = actualRef.current.length > 0 ? actualRef.current[actualRef.current.length - 1][0] : null
      if (lastActual !== null) {
        profileEndMsRef.current = lastActual
      }
    }

    if (oven.state === 'RUNNING') {
      // Normal live tick.
      const t = runStartMsRef.current + oven.runtime * 1000
      actualRef.current.push([t, Number.isFinite(oven.temperature) ? oven.temperature : null])
      targetRef.current.push([t, isTargetAvailable(oven) ? oven.target : null])
      clampHistory(actualRef.current, maxPoints)
      clampHistory(targetRef.current, maxPoints)
    } else if (oven.state === 'IDLE' && oven.cooldown_active && typeof oven.cooldown_elapsed === 'number') {
      // Cooldown tick.
      const endMs = profileEndMsRef.current ?? runStartMsRef.current
      const t = endMs + oven.cooldown_elapsed * 1000
      cooldownRef.current.push([t, Number.isFinite(oven.temperature) ? oven.temperature : null])
    }

    // Skip chart updates while user is dragging.
    if (setup.pointerDownRef.current) return

    setSeriesData(chart)
    setup.scheduleYAxisAutorange()

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
          window.setTimeout(() => { programmaticZoomRef.current = false }, 0)
        }
      }
    }
  }, [props.state, maxPoints, scheme])

  // --- Cleanup timer ---
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
