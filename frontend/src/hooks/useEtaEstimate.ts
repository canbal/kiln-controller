import { useEffect, useMemo, useRef, useState } from 'react'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'
import { apiGetSession, apiListSessions } from '../api/sessions'
import { fetchAllSessionSamples } from '../util/fetchSessionSamples'

type TempScale = 'f' | 'c' | null

type Sample = {
  elapsedS: number
  temp: number
  target: number
  pidOut: number | null
  heat: number | null
}

type RateSample = {
  temp: number
  rate: number
}

type Curve = {
  k: number | null
  tInf: number | null
  timeToHeat: (fromTemp: number, toTemp: number) => number
}

type UseEtaEstimateOpts = {
  oven: OvenState | null
  backlog: StatusBacklogEnvelope | null
  runtimeS: number | null
  elapsedS: number | null
  totalS: number | null
  tempScale: TempScale
  etaMaxTempF: number | null
}

const MAX_SAMPLES = 30_000
const MAX_RATE_SAMPLES = 20_000
const FULL_POWER_SAMPLE_WINDOW = 10

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function pidOutFromOven(oven: OvenState | null): number | null {
  if (!oven?.pidstats) return null
  const out = (oven.pidstats as Record<string, number>).out
  return finiteOrNull(out)
}

function heatFromOven(oven: OvenState | null): number | null {
  return finiteOrNull(oven?.heat)
}

function sampleFromState(
  state: unknown,
  elapsedOverride?: number,
  schedule?: Array<[number, number]> | null,
): Sample | null {
  if (!state || typeof state !== 'object') return null
  const rec = state as Record<string, unknown>
  const temp = finiteOrNull(rec.temperature)
  let target = finiteOrNull(rec.target)
  const runtime = finiteOrNull(rec.runtime)
  const elapsed = finiteOrNull(rec.elapsed)
  if (temp === null) return null
  const hasOverride = typeof elapsedOverride === 'number' && Number.isFinite(elapsedOverride)
  const elapsedS = hasOverride ? elapsedOverride : elapsed ?? runtime
  if (elapsedS === null) return null
  if ((target === null || !Number.isFinite(target)) && schedule && schedule.length > 0) {
    const fallback = interpolateTarget(schedule, elapsedS)
    if (fallback !== null) target = fallback
  }
  if (target === null || !Number.isFinite(target)) return null
  const pidOut = typeof rec.pidstats === 'object' && rec.pidstats !== null
    ? finiteOrNull((rec.pidstats as Record<string, unknown>).out)
    : null
  const heat = finiteOrNull(rec.heat)
  return { elapsedS, temp, target, pidOut, heat }
}

function isFullPower(oven: OvenState | null): boolean {
  const out = pidOutFromOven(oven)
  if (out !== null) return out >= 0.95

  const heat = heatFromOven(oven)
  if (heat === null) return false
  if (heat >= 0 && heat <= 1.2) return heat >= 0.95
  if (heat > 1.2 && heat <= 100) return heat >= 95
  return false
}

function isFullPowerSample(sample: Sample, assumeIfUnknown = false): boolean {
  if (sample.pidOut !== null) return sample.pidOut >= 0.95
  if (sample.heat === null) return assumeIfUnknown
  if (sample.heat >= 0 && sample.heat <= 1.2) return sample.heat >= 0.95
  if (sample.heat > 1.2 && sample.heat <= 100) return sample.heat >= 95
  return false
}

function isTrailingSample(sample: Sample, tempScale: TempScale): boolean {
  const delta = sample.target - sample.temp
  return delta > (tempScale === 'c' ? 3 : 5)
}

function isFallingBehindSample(sample: Sample, tempScale: TempScale): boolean {
  return isTrailingSample(sample, tempScale)
}

function shouldUseRatePair(opts: {
  prev: Sample
  next: Sample
  tempScale: TempScale
  assumeFullPowerIfUnknown: boolean
}): boolean {
  const { prev, next, tempScale, assumeFullPowerIfUnknown } = opts
  const dt = next.elapsedS - prev.elapsedS
  const dT = next.temp - prev.temp
  if (!(dt >= 0.5 && dt <= 5 && dT > 0)) return false
  if (!isFallingBehindSample(prev, tempScale)) return false
  if (!isFallingBehindSample(next, tempScale)) return false
  if (!isFullPowerSample(next, assumeFullPowerIfUnknown)) return false
  return true
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function etaMaxTempForScale(tempScale: TempScale, etaMaxTempF: number | null): number | null {
  if (etaMaxTempF === null || !Number.isFinite(etaMaxTempF) || !(etaMaxTempF > 0)) return null
  if (tempScale === 'c') return (etaMaxTempF - 32) * (5 / 9)
  return etaMaxTempF
}

function fitKFixedAsymptote(points: Array<{ temp: number; rate: number }>, tInf: number): number | null {
  if (points.length < 2) return null

  let usable = 0
  let sumX2 = 0
  let sumXY = 0

  for (const p of points) {
    if (!Number.isFinite(p.temp) || !Number.isFinite(p.rate)) continue
    if (!(p.rate > 0)) continue
    const x = tInf - p.temp
    if (!(x > 0)) continue
    usable += 1
    sumX2 += x * x
    sumXY += x * p.rate
  }

  if (usable < 2) return null
  if (!(sumX2 > 1e-12)) return null
  const k = sumXY / sumX2
  if (!Number.isFinite(k) || !(k > 0)) return null
  return k
}

function buildFlatCurve(rateSamples: RateSample[], minRate: number): Curve | null {
  const rates = rateSamples.map((s) => s.rate).filter((r) => Number.isFinite(r) && r > 0)
  const flat = median(rates)
  if (flat === null) return null
  const safeRate = Math.max(minRate, flat)
  const timeToHeat = (fromTemp: number, toTemp: number): number => {
    if (!Number.isFinite(fromTemp) || !Number.isFinite(toTemp) || !(toTemp > fromTemp)) return 0
    return Math.max(0, (toTemp - fromTemp) / safeRate)
  }
  return { k: null, tInf: null, timeToHeat }
}

function timeToHeatExponential(opts: {
  fromTemp: number
  toTemp: number
  k: number
  tInf: number
  minRate: number
  tempScale: TempScale
}): number {
  const { fromTemp, toTemp, k, tInf, minRate, tempScale } = opts
  if (!Number.isFinite(fromTemp) || !Number.isFinite(toTemp) || !Number.isFinite(k) || !Number.isFinite(tInf)) return 0
  if (!(k > 0) || !(toTemp > fromTemp)) return 0

  // Inverse of y(t) = T_inf - (T_inf - y0) * e^(-k t), with a min-rate floor near asymptote.
  const epsilon = tempScale === 'c' ? 0.25 : 0.5
  const capTemp = tInf - epsilon
  let from = fromTemp
  let to = toTemp
  let dt = 0

  if (from < capTemp) {
    const expTo = Math.min(to, capTemp)
    if (expTo > from) {
      const num = tInf - from
      const den = tInf - expTo
      if (num > 0 && den > 0) {
        const part = Math.log(num / den) / k
        if (!Number.isFinite(part) || part < 0) return 0
        dt += part
      } else {
        return Math.max(0, (toTemp - fromTemp) / minRate)
      }
      from = expTo
    }
  }

  if (to > from) {
    dt += (to - from) / minRate
  }

  if (!Number.isFinite(dt) || dt < 0) return 0
  return dt
}

function buildCurve(rateSamples: RateSample[], tempScale: TempScale, etaMaxTempF: number | null): Curve | null {
  if (rateSamples.length < 3) return null

  const minRate = tempScale === 'c' ? 0.005 : 0.01
  const raw = rateSamples.filter((s) => Number.isFinite(s.temp) && Number.isFinite(s.rate) && s.rate > 0)
  if (raw.length < 3) return null

  const tInf = etaMaxTempForScale(tempScale, etaMaxTempF)
  if (tInf === null) return null
  const k = fitKFixedAsymptote(raw, tInf)
  if (!(k && k > 1e-6)) return buildFlatCurve(raw, minRate)

  const timeToHeat = (fromTemp: number, toTemp: number): number => {
    return timeToHeatExponential({ fromTemp, toTemp, k, tInf, minRate, tempScale })
  }

  return { k, tInf, timeToHeat }
}

function interpolateTarget(profile: Array<[number, number]>, timeS: number): number | null {
  if (!profile.length) return null
  if (timeS <= profile[0][0]) return profile[0][1]
  const last = profile[profile.length - 1]
  if (timeS >= last[0]) return last[1]

  for (let i = 1; i < profile.length; i += 1) {
    const [t1, temp1] = profile[i]
    const [t0, temp0] = profile[i - 1]
    if (timeS <= t1) {
      const span = t1 - t0
      if (!(span > 0)) return temp1
      const pct = (timeS - t0) / span
      return temp0 + (temp1 - temp0) * pct
    }
  }
  return last[1]
}

function computeCatchUpDelay(opts: {
  profile: Array<[number, number]>
  runtimeS: number
  currentTemp: number
  curve: Curve
}): number {
  const { profile, runtimeS, currentTemp, curve } = opts
  if (profile.length < 2) return 0

  const ordered = [...profile].sort((a, b) => a[0] - b[0])
  const duration = ordered[ordered.length - 1][0]
  if (!(duration > 0)) return 0

  const clampedRuntime = Math.max(0, Math.min(runtimeS, duration))
  const targetAtRuntime = interpolateTarget(ordered, clampedRuntime)
  if (targetAtRuntime === null) return 0

  const maxSegmentDelayS = 12 * 3600
  const maxTotalDelayS = 48 * 3600
  let delay = 0

  let segStartTime = clampedRuntime
  let segStartTarget = targetAtRuntime
  let segStartTemp = Math.min(currentTemp, targetAtRuntime)

  let startIndex = 0
  while (startIndex < ordered.length && ordered[startIndex][0] <= clampedRuntime) startIndex += 1

  for (let i = startIndex; i < ordered.length; i += 1) {
    const [segEndTime, segEndTarget] = ordered[i]
    if (!(segEndTime > segStartTime)) continue

    const tempSpan = segEndTarget - segStartTarget
    const scheduledTime = segEndTime - segStartTime

    if (tempSpan > 0) {
      let temp = segStartTemp
      if (temp > segEndTarget) temp = segEndTarget

      const achievable = curve.timeToHeat(temp, segEndTarget)
      if (achievable > scheduledTime) {
        delay += Math.min(maxSegmentDelayS, achievable - scheduledTime)
      }
    }

    segStartTime = segEndTime
    segStartTarget = segEndTarget
    segStartTemp = segEndTarget
  }

  return Math.max(0, Math.min(delay, maxTotalDelayS))
}

function isCatchingUp(oven: OvenState | null, tempScale: TempScale): boolean {
  if (!oven) return false
  const out = pidOutFromOven(oven)
  const full = out !== null ? out >= 0.95 : isFullPower(oven)
  if (!full) return false
  const target = finiteOrNull(oven.target)
  const temp = finiteOrNull(oven.temperature)
  if (target === null || temp === null) return false
  const delta = target - temp
  return delta > (tempScale === 'c' ? 3 : 5)
}

export function useEtaEstimate(opts: UseEtaEstimateOpts): { eta: number | null } {
  const { oven, backlog, runtimeS, elapsedS, totalS, tempScale, etaMaxTempF } = opts
  const [eta, setEta] = useState<number | null>(null)

  const samplesRef = useRef<Sample[]>([])
  const rateSamplesRef = useRef<RateSample[]>([])
  const fullPowerSinceFitRef = useRef(0)
  const curveRef = useRef<Curve | null>(null)
  const delayRef = useRef(0)
  const lastCatchUpAtRef = useRef<number | null>(null)
  const lastProfileRef = useRef<string | null>(null)
  const lastRuntimeRef = useRef<number | null>(null)
  const seededRef = useRef(false)
  const dbSeededRef = useRef(false)
  const dbFetchPendingRef = useRef(false)
  const dbFetchDoneRef = useRef(false)
  const scheduleRef = useRef<Array<[number, number]> | null>(null)

  const remainingS = useMemo(() => {
    if (runtimeS === null || totalS === null) return null
    if (!Number.isFinite(runtimeS) || !Number.isFinite(totalS)) return null
    return Math.max(0, totalS - runtimeS)
  }, [runtimeS, totalS])

  const appendSample = (
    sample: Sample,
    opts?: { assumeFullPowerIfUnknown?: boolean; skipRateSample?: boolean },
  ) => {
    const prev = samplesRef.current[samplesRef.current.length - 1]
    if (prev && sample.elapsedS <= prev.elapsedS + 0.1) return

    samplesRef.current.push(sample)
    if (samplesRef.current.length > MAX_SAMPLES) {
      samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES)
    }

    if (!prev) return
    if (opts?.skipRateSample) return
    const dt = sample.elapsedS - prev.elapsedS
    const dT = sample.temp - prev.temp
    const assumeFullPowerIfUnknown = opts?.assumeFullPowerIfUnknown ?? false
    if (shouldUseRatePair({ prev, next: sample, tempScale, assumeFullPowerIfUnknown })) {
      const rate = dT / dt
      if (Number.isFinite(rate) && rate > 0) {
        rateSamplesRef.current.push({ temp: (sample.temp + prev.temp) / 2, rate })
        if (rateSamplesRef.current.length > MAX_RATE_SAMPLES) {
          rateSamplesRef.current.splice(0, rateSamplesRef.current.length - MAX_RATE_SAMPLES)
        }
        fullPowerSinceFitRef.current += 1
      }
    }
  }

  useEffect(() => {
    if (!oven || oven.state !== 'RUNNING') return
    if (dbSeededRef.current || dbFetchPendingRef.current) return

    const ac = new AbortController()
    dbFetchPendingRef.current = true
    dbFetchDoneRef.current = false

    const run = async () => {
      const listRes = await apiListSessions({ limit: 5, signal: ac.signal })
      if (!listRes.ok) throw new Error(listRes.error)
      const active = listRes.value.find((s) => s.ended_at === null)
      if (!active) throw new Error('no_active_session')

      const detailRes = await apiGetSession({ sessionId: active.id, signal: ac.signal })
      if (!detailRes.ok) throw new Error(detailRes.error)
      const session = detailRes.value

      scheduleRef.current =
        session.schedule && session.schedule.length > 0 ? session.schedule : backlog?.profile?.data ?? null

      const startedAt = session.started_at ?? session.created_at
      const samples = await fetchAllSessionSamples({ sessionId: active.id, from: startedAt, signal: ac.signal })

      // DB seed should be authoritative on first load.
      samplesRef.current = []
      rateSamplesRef.current = []
      fullPowerSinceFitRef.current = 0
      const schedule = scheduleRef.current
      let prevDb: { t: number; sample: Sample } | null = null
      for (const s of samples) {
        const elapsedS = Number.isFinite(s.t) && Number.isFinite(startedAt) ? s.t - startedAt : undefined
        const sample = sampleFromState(s.state, elapsedS, schedule)
        if (!sample) continue
        appendSample(sample, { assumeFullPowerIfUnknown: true, skipRateSample: true })

        if (prevDb) {
          const dt = s.t - prevDb.t
          const dT = sample.temp - prevDb.sample.temp
          if (shouldUseRatePair({ prev: prevDb.sample, next: sample, tempScale, assumeFullPowerIfUnknown: true })) {
            const rate = dT / dt
            if (Number.isFinite(rate) && rate > 0) {
              rateSamplesRef.current.push({ temp: (sample.temp + prevDb.sample.temp) / 2, rate })
              if (rateSamplesRef.current.length > MAX_RATE_SAMPLES) {
                rateSamplesRef.current.splice(0, rateSamplesRef.current.length - MAX_RATE_SAMPLES)
              }
            }
          }
        }
        prevDb = { t: s.t, sample }
      }
      dbSeededRef.current = true
    }

    run()
      .catch(() => {
        // ignore DB seed errors; fallback to backlog/live.
      })
      .finally(() => {
        dbFetchPendingRef.current = false
        dbFetchDoneRef.current = true
      })

    return () => ac.abort()
  }, [oven, backlog, tempScale])

  useEffect(() => {
    if (!oven || oven.state !== 'RUNNING') {
      samplesRef.current = []
      rateSamplesRef.current = []
      fullPowerSinceFitRef.current = 0
      curveRef.current = null
      delayRef.current = 0
      lastCatchUpAtRef.current = null
      lastProfileRef.current = null
      lastRuntimeRef.current = null
      seededRef.current = false
      dbSeededRef.current = false
      dbFetchPendingRef.current = false
      dbFetchDoneRef.current = false
      scheduleRef.current = null
      setEta(null)
      return
    }

    const runtime = runtimeS
    const elapsed = elapsedS ?? runtimeS
    if (runtime === null || elapsed === null) return
    if (!Number.isFinite(runtime) || !Number.isFinite(elapsed)) return

    const profileName = oven.profile ?? null
    if (
      profileName !== lastProfileRef.current ||
      (lastRuntimeRef.current !== null && runtime < lastRuntimeRef.current - 5)
    ) {
      samplesRef.current = []
      rateSamplesRef.current = []
      fullPowerSinceFitRef.current = 0
      curveRef.current = null
      delayRef.current = 0
      lastCatchUpAtRef.current = null
      seededRef.current = false
      dbSeededRef.current = false
      dbFetchPendingRef.current = false
      dbFetchDoneRef.current = false
      scheduleRef.current = null
    }
    lastProfileRef.current = profileName
    lastRuntimeRef.current = runtime

    if (!seededRef.current && backlog?.log?.length) {
      const schedule = scheduleRef.current ?? backlog.profile?.data ?? null
      for (const entry of backlog.log) {
        const entryElapsed = finiteOrNull((entry as OvenState).elapsed) ?? finiteOrNull(entry.runtime)
        const sample = sampleFromState(entry, entryElapsed ?? undefined, schedule)
        if (!sample) continue
        appendSample(sample, { assumeFullPowerIfUnknown: true })
      }
      seededRef.current = true
    }

    const temp = finiteOrNull(oven.temperature)
    const target = finiteOrNull(oven.target)
    if (temp === null || target === null) return

    const sample: Sample = {
      elapsedS: elapsed,
      temp,
      target,
      pidOut: pidOutFromOven(oven),
      heat: heatFromOven(oven),
    }
    appendSample(sample)

    const catchingUp = isCatchingUp(oven, tempScale)

    const dbReady = dbFetchDoneRef.current
    if (!dbReady) {
      setEta(null)
      return
    }

    if (!catchingUp) {
      const now = Date.now()
      if (lastCatchUpAtRef.current === null) {
        lastCatchUpAtRef.current = now
      }
      // Only reset delay after we've been on-schedule for a while.
      if (now - lastCatchUpAtRef.current > 120_000) {
        delayRef.current = 0
      }
      setEta(remainingS)
      return
    }

    if (
      fullPowerSinceFitRef.current >= FULL_POWER_SAMPLE_WINDOW ||
      (curveRef.current === null && rateSamplesRef.current.length >= FULL_POWER_SAMPLE_WINDOW)
    ) {
      lastCatchUpAtRef.current = Date.now()
      curveRef.current = buildCurve(rateSamplesRef.current, tempScale, etaMaxTempF)
      fullPowerSinceFitRef.current = 0
      const schedule = scheduleRef.current ?? backlog?.profile?.data ?? null
      if (curveRef.current && schedule && runtimeS !== null && Number.isFinite(runtimeS)) {
        delayRef.current = computeCatchUpDelay({
          profile: schedule,
          runtimeS,
          currentTemp: temp,
          curve: curveRef.current,
        })
      }
    }

    const calculating =
      curveRef.current === null || (delayRef.current === 0 && rateSamplesRef.current.length < FULL_POWER_SAMPLE_WINDOW)
    if (calculating || remainingS === null) {
      setEta(null)
      return
    }

    setEta(remainingS + delayRef.current)
  }, [oven, backlog, runtimeS, elapsedS, remainingS, tempScale, etaMaxTempF])

  return { eta }
}
