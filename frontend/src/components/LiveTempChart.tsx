import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'
import { apiListSessions, apiGetSession } from '../api/sessions'
import { extractTemp, extractTarget } from '../util/sampleExtract'
import { fetchAllSessionSamples } from '../util/fetchSessionSamples'
import type { Point } from '../util/chartFormatting'
import { schemeForTheme } from '../util/chartTheme'
import { readZoomWindowValues } from '../util/chartZoom'
import { buildBaseOption, buildMarkLine, buildMarkArea } from '../util/chartOptions'
import { useChartCore } from '../hooks/useChartCore'

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

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)
  useEffect(() => { unitRef.current = unit }, [unit])

  const [loading, setLoading] = useState(true)
  const [followLive, setFollowLive] = useState(true)
  const followLiveRef = useRef(true)
  const [autoLiveWindow, setAutoLiveWindow] = useState(true)
  const autoLiveWindowRef = useRef(true)
  const zoomSpanPctRef = useRef(20)

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

  const maxPoints = 24 * 60 * 60 // 24 hours at 1 Hz
  const LIVE_WINDOW_MS = 30 * 60 * 1000
  const MIN_ZOOM_MS = 10 * 1000

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

  const baseOption = useMemo(
    () => buildBaseOption(scheme, unitRef, { dataZoomStart: 80, seriesEmphasis: true }),
    [scheme],
  )

  const {
    hostRef, chartRef, setupRef,
    zoomSpanLabel, showZoomSpanHint, programmaticZoom,
  } = useChartCore(baseOption, {
    onManualZoom: () => {
      autoLiveWindowRef.current = false
      setAutoLiveWindow(false)
      followLiveRef.current = false
      setFollowLive(false)
      showZoomSpanHint()
    },
    getDataExtent: chartDataExtent,
    getSeriesForYRange: () => ({
      scan: [actualRef.current, cooldownRef.current, targetRef.current],
      interpolate: [scheduleRef.current],
    }),
    minZoomMs: MIN_ZOOM_MS,
  })

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
    followLiveRef.current = true
    setFollowLive(true)
    setAutoLiveWindow(true)
    const chart = chartRef.current
    if (!chart) return

    zoomSpanPctRef.current = 20
    autoLiveWindowRef.current = true

    const extent = timeExtent()
    if (extent) {
      const span = extent.max - extent.min
      if (span < LIVE_WINDOW_MS) {
        programmaticZoom({
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
            { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
          ],
        })
      } else {
        const endValue = extent.max
        const startValue = endValue - LIVE_WINDOW_MS
        programmaticZoom({
          dataZoom: [
            { rangeMode: ['value', 'value'], startValue, endValue },
            { rangeMode: ['value', 'value'], startValue, endValue },
          ],
        })
      }
    } else {
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
    }
  }

  const applyAutoLiveWindow = () => {
    const extent = timeExtent()
    if (!extent) return

    const span = extent.max - extent.min
    if (span < LIVE_WINDOW_MS) {
      programmaticZoom({
        dataZoom: [
          { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
          { rangeMode: ['value', 'value'], startValue: extent.min, endValue: extent.max },
        ],
      })
      return
    }

    const endValue = extent.max
    const startValue = endValue - LIVE_WINDOW_MS
    programmaticZoom({
      dataZoom: [
        { rangeMode: ['value', 'value'], startValue, endValue },
        { rangeMode: ['value', 'value'], startValue, endValue },
      ],
    })
  }

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

    // Attempt DB seed: RUNNING, IDLE + cooldown, or IDLE (show last completed session).
    const isRunning = lastLog?.state === 'RUNNING'
    const isCooldown = lastLog?.state === 'IDLE' && lastLog.cooldown_active === true && typeof lastLog.cooldown_session_id === 'string'

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

        for (const s of samples) {
          const tMs = s.t * 1000
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

        actualRef.current = actual
        targetRef.current = target
        cooldownRef.current = cooldown

      } else if (isRunning) {
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

        const actual: Point[] = []
        const target: Point[] = []
        for (const s of samples) {
          const tMs = s.t * 1000
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
        const lastDbMs = actual.length > 0 ? actual[actual.length - 1][0] : runStartMs
        const buffered = wsPendingBufferRef.current
        wsPendingBufferRef.current = []
        for (const entry of buffered) {
          const entryT = runStartMs + (typeof entry.elapsed === 'number' ? entry.elapsed : entry.runtime) * 1000
          if (entryT <= lastDbMs) continue
          actual.push([entryT, Number.isFinite(entry.temperature) ? entry.temperature : null])
          target.push([entryT, isTargetAvailable(entry) ? entry.target : null])
        }

        actualRef.current = actual
        targetRef.current = target
        scheduleRef.current = schedule

      } else {
        // Idle without cooldown: load the most recent completed session.
        const listRes = await apiListSessions({ limit: 10, signal: ac.signal })
        if (!listRes.ok) throw new Error(listRes.error)
        const completed = listRes.value.find((s) => s.outcome === 'COMPLETED' && typeof s.ended_at === 'number')
          ?? listRes.value.find((s) => typeof s.ended_at === 'number')
        if (!completed) throw new Error('no_completed_session')

        sessionId = completed.id
        const detailRes3 = await apiGetSession({ sessionId, signal: ac.signal })
        if (!detailRes3.ok) throw new Error(detailRes3.error)
        const session3 = detailRes3.value

        startedAt = session3.started_at ?? session3.created_at
        const runStartMs = startedAt * 1000
        runStartMsRef.current = runStartMs

        let schedule: Point[] = []
        if (session3.schedule && session3.schedule.length > 0) {
          schedule = session3.schedule.map(([sec, temp]) => [runStartMs + sec * 1000, temp] as Point)
        }
        scheduleRef.current = schedule

        const endedAt = session3.ended_at
        if (typeof endedAt === 'number') {
          profileEndMsRef.current = endedAt * 1000
        }

        const samples = await fetchAllSessionSamples({ sessionId, from: startedAt, signal: ac.signal })
        const actual: Point[] = []
        const target: Point[] = []
        const cooldown: Point[] = []

        for (const s of samples) {
          const tMs = s.t * 1000
          if (typeof endedAt === 'number' && s.t > endedAt) {
            cooldown.push([tMs, extractTemp(s.state)])
          } else {
            actual.push([tMs, extractTemp(s.state)])
            target.push([tMs, extractTarget(s.state)])
          }
        }

        actualRef.current = actual
        targetRef.current = target
        cooldownRef.current = cooldown
        wsPendingBufferRef.current = []
      }

      // Seed the chart.
      const chart = chartRef.current
      if (!chart) return

      lastPointAtRef.current = Date.now()
      setSeriesData(chart)
      setupRef.current?.scheduleYAxisAutorange()

      if (followLiveRef.current && autoLiveWindowRef.current) {
        applyAutoLiveWindow()
      }

      seededRef.current = true
      dbFetchDoneRef.current = true
      dbFetchPendingRef.current = false
      setLoading(false)
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
    const lastElapsed = lastLog && typeof lastLog.elapsed === 'number' ? lastLog.elapsed : lastLog?.runtime ?? 0
    const runStartMs = lastLog ? now - lastElapsed * 1000 : now
    runStartMsRef.current = runStartMs

    const actual: Point[] = []
    const target: Point[] = []

    for (let i = 0; i < log.length; i++) {
      const oven = log[i]
      const t = runStartMs + (typeof oven.elapsed === 'number' ? oven.elapsed : oven.runtime) * 1000
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
    setLoading(false)

    const chart = chartRef.current
    setSeriesData(chart)
    setupRef.current?.scheduleYAxisAutorange()

    if (followLiveRef.current && autoLiveWindowRef.current) {
      applyAutoLiveWindow()
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
      // Normal live tick — use wall-clock elapsed (not runtime, which pauses on catch-up).
      const t = runStartMsRef.current + (typeof oven.elapsed === 'number' ? oven.elapsed : oven.runtime) * 1000
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
        applyAutoLiveWindow()
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

          programmaticZoom({
            dataZoom: [
              { rangeMode: ['value', 'value'], startValue: sv, endValue: ev },
              { rangeMode: ['value', 'value'], startValue: sv, endValue: ev },
            ],
          })
        }
      }
    }
  }, [props.state, maxPoints, scheme])

  // Hide x-axis and slider while loading.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(
      { legend: { show: !loading }, xAxis: { show: !loading }, dataZoom: [{}, { show: !loading }] },
      { notMerge: false, lazyUpdate: true },
    )
  }, [loading])

  return (
    <div className="liveChartWrap" aria-label="Live temperature chart">
      {loading ? <div className="chartLoading">Loading data</div> : null}
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
