import { useEffect, useMemo, useRef, useState } from 'react'
import { apiGetSession, apiListSessions } from '../api/sessions'
import type { Session } from '../contract/sessions'
import { fetchSamplesWindow } from '../util/fetchSessionSamples'
import type { Point } from '../util/chartFormatting'
import { schemeForTheme } from '../util/chartTheme'
import { resetYAxisCache } from '../util/chartSetup'
import { buildBaseOption, buildMarkLine, buildMarkArea } from '../util/chartOptions'
import { useChartCore } from '../hooks/useChartCore'

type SessionChartProps = {
  sessionId?: string
  tempScale: 'f' | 'c' | null
  theme?: 'stoneware' | 'dark'
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

export function SessionChart(props: SessionChartProps) {
  const theme = props.theme ?? 'stoneware'
  const scheme = useMemo(() => schemeForTheme(theme), [theme])

  const unit = props.tempScale === 'c' ? 'C' : props.tempScale === 'f' ? 'F' : ''
  const unitRef = useRef(unit)
  useEffect(() => { unitRef.current = unit }, [unit])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [sampleCount, setSampleCount] = useState(0)
  const [zoomed, setZoomed] = useState(false)

  const seriesDataRef = useRef<[Point[], Point[], Point[], Point[], Point[]]>([[], [], [], [], []])
  const timeExtentMsRef = useRef<{ min: number; max: number } | null>(null)

  const baseOption = useMemo(
    () => buildBaseOption(scheme, unitRef, { seriesActualName: 'Actual (profile)' }),
    [scheme],
  )

  const {
    hostRef, chartRef, setupRef,
    zoomSpanLabel, showZoomSpanHint, programmaticZoom,
  } = useChartCore(baseOption, {
    onManualZoom: () => { setZoomed(true); showZoomSpanHint() },
    getDataExtent: () => timeExtentMsRef.current,
    getSeriesForYRange: () => {
      const [s0, s1, s2, s3] = seriesDataRef.current
      return { scan: [s0, s1, s2], interpolate: [s3] }
    },
    minZoomMs: 10_000,
  })

  // Hide x-axis and slider while loading.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(
      { legend: { show: !loading }, xAxis: { show: !loading }, dataZoom: [{}, { show: !loading }] },
      { notMerge: false, lazyUpdate: true },
    )
  }, [loading])

  const resetZoom = () => {
    const chart = chartRef.current
    if (!chart) return
    const ext = timeExtentMsRef.current
    if (ext) {
      programmaticZoom({
        dataZoom: [
          { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
          { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
        ],
      })
    } else {
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
    }
    setZoomed(false)
  }

  // --- Data fetch effect ---
  useEffect(() => {
    const ac = new AbortController()

    const run = async () => {
      setLoading(true)
      setError(null)
      setSession(null)

      let picked: Session | null = null

      if (props.sessionId) {
        const detailRes = await apiGetSession({ sessionId: props.sessionId, signal: ac.signal })
        if (!detailRes.ok) {
          setError(detailRes.error)
          setLoading(false)
          return
        }
        picked = detailRes.value
      } else {
        const sessRes = await apiListSessions({ limit: 10, offset: 0, signal: ac.signal })
        if (!sessRes.ok) {
          setError(sessRes.error)
          setLoading(false)
          return
        }

        picked = pickMostRecentCompleted(sessRes.value)
        if (!picked) {
          setError('No sessions found')
          setLoading(false)
          return
        }
      }

      setSession(picked)

      // Fetch full session detail (includes schedule from meta_json).
      const detailRes = await apiGetSession({ sessionId: picked.id, signal: ac.signal })

      // Fetch samples for the session time window.
      const startedAt = typeof picked.started_at === 'number' ? picked.started_at : null
      const endedAt = typeof picked.ended_at === 'number' ? picked.ended_at : null
      const endSec = endedAt ?? Math.floor(Date.now() / 1000)
      const startSec = startedAt ?? Math.max(0, endSec - 3600)

      const samples = await fetchSamplesWindow({
        from: startSec,
        to: endSec,
        maxPoints: 2000,
        signal: ac.signal,
      })

      // Build chart data.
      const startedAtSec = startedAt
      const endMs = endedAt !== null ? endedAt * 1000 : null

      const actualProfile: Point[] = []
      const actualCooldown: Point[] = []
      const target: Point[] = []
      const power: Point[] = []

      for (const s of samples) {
        const tMs = s.t * 1000
        const temp = s.temp ?? null
        const tgt = s.target ?? null
        const pwr = s.power_percent ?? null

        if (endMs !== null && tMs > endMs) {
          actualCooldown.push([tMs, temp])
          target.push([tMs, null])
          power.push([tMs, pwr])
        } else {
          actualProfile.push([tMs, temp])
          target.push([tMs, tgt])
          actualCooldown.push([tMs, null])
          power.push([tMs, pwr])
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

      // Store in refs for chart updates.
      seriesDataRef.current = [actualProfile, actualCooldown, target, schedule, power]

      const firstMs = samples.length ? samples[0].t * 1000 : null
      const lastMs = samples.length ? samples[samples.length - 1].t * 1000 : null
      timeExtentMsRef.current = firstMs !== null && lastMs !== null && lastMs > firstMs ? { min: firstMs, max: lastMs } : null

      // Update chart.
      const chart = chartRef.current
      const setup = setupRef.current
      if (chart && setup) {
        const hasTail = actualCooldown.some((p) => p[1] !== null)
        const maxMs = samples.length ? samples[samples.length - 1].t * 1000 : null
        const hasMarkArea = endMs !== null && maxMs !== null && maxMs > endMs

        chart.setOption(
          {
            series: [
              {
                data: actualProfile,
                markLine: endMs !== null ? buildMarkLine(endMs, scheme) : undefined,
              },
              {
                data: actualCooldown,
                lineStyle: { width: 2, type: hasTail ? 'solid' : 'dotted' },
                markArea: hasMarkArea ? buildMarkArea(endMs, maxMs!, scheme) : undefined,
              },
              { data: target },
              { data: schedule },
              { data: power },
            ],
          },
          { notMerge: false, lazyUpdate: true },
        )

        // Anchor zoom to sample extent.
        const ext = timeExtentMsRef.current
        if (ext) {
          programmaticZoom({
            dataZoom: [
              { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
              { rangeMode: ['value', 'value'], startValue: ext.min, endValue: ext.max },
            ],
          })
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
  }, [scheme, props.sessionId])

  const endpointHint = useMemo(() => {
    if (!error) return null
    if (error.includes('HTTP_404') || error.includes('Expected JSON')) {
      return `Try: curl ${window.location.origin}/v1/sessions`
    }
    return null
  }, [error])

  return (
    <div className="recentSession" aria-label="Session chart">
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
        {loading ? <div className="chartLoading">Loading data</div> : null}
        {zoomed ? (
          <button type="button" className="chartReset" onClick={resetZoom} aria-label="Reset chart zoom">
            Reset Zoom
          </button>
        ) : null}
        {zoomSpanLabel ? <div className="chartZoomSpan" aria-live="polite">{zoomSpanLabel}</div> : null}
        <div ref={hostRef} className="liveChart sessionChart" />
      </div>

      {session && typeof session.ended_at !== 'number' ? (
        <p className="muted">Note: this session has no end timestamp yet; cooldown tail marker is unavailable.</p>
      ) : null}
      {session && session.outcome !== 'COMPLETED' ? (
        <p className="muted">Note: cooldown tail sampling is only expected for COMPLETED runs.</p>
      ) : null}
    </div>
  )
}
