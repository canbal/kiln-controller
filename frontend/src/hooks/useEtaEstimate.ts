import { useEffect, useMemo, useRef, useState } from 'react'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'

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
  temps: number[]
  rates: number[]
  minRate: number
  rateAt: (temp: number) => number
}

type UseEtaEstimateOpts = {
  oven: OvenState | null
  backlog: StatusBacklogEnvelope | null
  runtimeS: number | null
  elapsedS: number | null
  totalS: number | null
  tempScale: TempScale
}

const MAX_SAMPLES = 30_000
const MAX_RATE_SAMPLES = 20_000
const FULL_POWER_SAMPLE_WINDOW = 30

export type EtaDebugInfo = {
  catchingUp: boolean
  fullPower: boolean
  pidOut: number | null
  targetDelta: number | null
  samples: number
  rateSamples: number
  fullPowerSinceFit: number
  curveBins: number
  delayS: number
  lastFitAtMs: number | null
  profilePoints: number
}

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

function isFullPower(oven: OvenState | null): boolean {
  const out = pidOutFromOven(oven)
  if (out !== null) return out >= 0.95

  const heat = heatFromOven(oven)
  if (heat === null) return false
  if (heat >= 0 && heat <= 1.2) return heat >= 0.95
  if (heat > 1.2 && heat <= 100) return heat >= 95
  return false
}

function isFullPowerSample(sample: Sample): boolean {
  if (sample.pidOut !== null) return sample.pidOut >= 0.95
  if (sample.heat === null) return false
  if (sample.heat >= 0 && sample.heat <= 1.2) return sample.heat >= 0.95
  if (sample.heat > 1.2 && sample.heat <= 100) return sample.heat >= 95
  return false
}

function isTrailingSample(sample: Sample, tempScale: TempScale): boolean {
  const delta = sample.target - sample.temp
  return delta > (tempScale === 'c' ? 3 : 5)
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function solve3x3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]])

  for (let col = 0; col < 3; col += 1) {
    let pivot = col
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const tmp = m[col]
      m[col] = m[pivot]
      m[pivot] = tmp
    }

    const div = m[col][col]
    for (let k = col; k < 4; k += 1) m[col][k] /= div

    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue
      const factor = m[row][col]
      for (let k = col; k < 4; k += 1) m[row][k] -= factor * m[col][k]
    }
  }

  return [m[0][3], m[1][3], m[2][3]]
}

function fitQuadratic(points: Array<{ x: number; y: number }>): { a: number; b: number; c: number } | null {
  if (points.length < 3) return null

  let n = 0
  let sumX = 0
  let sumX2 = 0
  let sumX3 = 0
  let sumX4 = 0
  let sumY = 0
  let sumXY = 0
  let sumX2Y = 0

  for (const p of points) {
    const x = p.x
    const y = p.y
    const x2 = x * x
    n += 1
    sumX += x
    sumX2 += x2
    sumX3 += x2 * x
    sumX4 += x2 * x2
    sumY += y
    sumXY += x * y
    sumX2Y += x2 * y
  }

  const coeffs = solve3x3(
    [
      [n, sumX, sumX2],
      [sumX, sumX2, sumX3],
      [sumX2, sumX3, sumX4],
    ],
    [sumY, sumXY, sumX2Y],
  )

  if (!coeffs) return null
  const [c, b, a] = coeffs
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
  return { a, b, c }
}

function buildCurve(rateSamples: RateSample[], tempScale: TempScale): Curve | null {
  if (rateSamples.length < 5) return null

  const binSize = tempScale === 'c' ? 10 : 25
  const minRate = tempScale === 'c' ? 0.005 : 0.01

  const bins = new Map<number, number[]>()
  for (const sample of rateSamples) {
    if (!(sample.rate > 0)) continue
    const bin = Math.floor(sample.temp / binSize) * binSize + binSize / 2
    const arr = bins.get(bin)
    if (arr) arr.push(sample.rate)
    else bins.set(bin, [sample.rate])
  }

  const points: Array<{ temp: number; rate: number }> = []
  for (const [temp, rates] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
    const med = median(rates)
    if (med !== null && med > 0) points.push({ temp, rate: med })
  }

  if (points.length < 3) return null

  const fit = fitQuadratic(points.map((p) => ({ x: p.temp, y: p.rate })))

  const temps = points.map((p) => p.temp)
  const rawRates = points.map((p) => {
    if (fit) {
      const r = fit.a * p.temp * p.temp + fit.b * p.temp + fit.c
      if (Number.isFinite(r) && r > 0) return r
    }
    return p.rate
  })

  const rates: number[] = []
  for (let i = 0; i < rawRates.length; i += 1) {
    const prev = i > 0 ? rates[i - 1] : rawRates[i]
    const clamped = Math.min(rawRates[i], prev)
    rates.push(Math.max(minRate, clamped))
  }

  const rateAt = (temp: number): number => {
    if (!Number.isFinite(temp)) return minRate
    if (temp <= temps[0]) return rates[0]
    const lastIdx = temps.length - 1
    if (temp >= temps[lastIdx]) {
      if (fit) {
        const r = fit.a * temp * temp + fit.b * temp + fit.c
        if (Number.isFinite(r)) return Math.max(minRate, Math.min(r, rates[lastIdx]))
      }
      return rates[lastIdx]
    }

    let hi = temps.findIndex((t) => t >= temp)
    if (hi <= 0) return rates[0]
    const lo = hi - 1
    const t0 = temps[lo]
    const t1 = temps[hi]
    const r0 = rates[lo]
    const r1 = rates[hi]
    const pct = (temp - t0) / (t1 - t0)
    const interp = r0 + (r1 - r0) * pct
    return Math.max(minRate, interp)
  }

  return { temps, rates, minRate, rateAt }
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
  tempScale: TempScale
}): number {
  const { profile, runtimeS, currentTemp, curve, tempScale } = opts
  if (profile.length < 2) return 0

  const ordered = [...profile].sort((a, b) => a[0] - b[0])
  const duration = ordered[ordered.length - 1][0]
  if (!(duration > 0)) return 0

  const clampedRuntime = Math.max(0, Math.min(runtimeS, duration))
  const targetAtRuntime = interpolateTarget(ordered, clampedRuntime)
  if (targetAtRuntime === null) return 0

  const step = tempScale === 'c' ? 0.5 : 1
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

      let achievable = 0
      for (let t = temp; t < segEndTarget; t += step) {
        const nextT = Math.min(segEndTarget, t + step)
        const mid = (t + nextT) / 2
        const rate = curve.rateAt(mid)
        achievable += (nextT - t) / rate
      }

      if (achievable > scheduledTime) delay += achievable - scheduledTime
    }

    segStartTime = segEndTime
    segStartTarget = segEndTarget
    segStartTemp = segEndTarget
  }

  return Math.max(0, delay)
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

export function useEtaEstimate(opts: UseEtaEstimateOpts): { eta: number | null; debug: EtaDebugInfo | null } {
  const { oven, backlog, runtimeS, elapsedS, totalS, tempScale } = opts
  const [eta, setEta] = useState<number | null>(null)
  const [debug, setDebug] = useState<EtaDebugInfo | null>(null)

  const samplesRef = useRef<Sample[]>([])
  const rateSamplesRef = useRef<RateSample[]>([])
  const fullPowerSinceFitRef = useRef(0)
  const curveRef = useRef<Curve | null>(null)
  const delayRef = useRef(0)
  const lastFitAtRef = useRef<number | null>(null)
  const lastProfileRef = useRef<string | null>(null)
  const lastRuntimeRef = useRef<number | null>(null)
  const seededRef = useRef(false)

  const remainingS = useMemo(() => {
    if (runtimeS === null || totalS === null) return null
    if (!Number.isFinite(runtimeS) || !Number.isFinite(totalS)) return null
    return Math.max(0, totalS - runtimeS)
  }, [runtimeS, totalS])

  useEffect(() => {
    if (!oven || oven.state !== 'RUNNING') {
      samplesRef.current = []
      rateSamplesRef.current = []
      fullPowerSinceFitRef.current = 0
      curveRef.current = null
      delayRef.current = 0
      lastFitAtRef.current = null
      lastProfileRef.current = null
      lastRuntimeRef.current = null
      seededRef.current = false
      setEta(null)
      setDebug(null)
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
      lastFitAtRef.current = null
      seededRef.current = false
    }
    lastProfileRef.current = profileName
    lastRuntimeRef.current = runtime

    if (!seededRef.current && backlog?.log?.length) {
      for (const entry of backlog.log) {
        const entryElapsed = finiteOrNull((entry as OvenState).elapsed) ?? finiteOrNull(entry.runtime)
        if (entryElapsed === null) continue
        const temp = finiteOrNull(entry.temperature)
        const target = finiteOrNull(entry.target)
        if (temp === null || target === null) continue
        const sample: Sample = {
          elapsedS: entryElapsed,
          temp,
          target,
          pidOut: pidOutFromOven(entry as OvenState),
          heat: heatFromOven(entry as OvenState),
        }
        const prev = samplesRef.current[samplesRef.current.length - 1]
        if (!prev || sample.elapsedS > prev.elapsedS + 0.1) {
          samplesRef.current.push(sample)
          if (samplesRef.current.length > MAX_SAMPLES) {
            samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES)
          }
          if (prev) {
            const dt = sample.elapsedS - prev.elapsedS
            const dT = sample.temp - prev.temp
            if (dt >= 0.5 && dt <= 5 && dT > 0 && isFullPowerSample(sample) && isTrailingSample(sample, tempScale)) {
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
        }
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

    const prev = samplesRef.current[samplesRef.current.length - 1]
    if (!prev || sample.elapsedS > prev.elapsedS + 0.1) {
      samplesRef.current.push(sample)
      if (samplesRef.current.length > MAX_SAMPLES) {
        samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES)
      }

      if (prev) {
        const dt = sample.elapsedS - prev.elapsedS
        const dT = sample.temp - prev.temp
        if (dt >= 0.5 && dt <= 5 && dT > 0 && isFullPowerSample(sample) && isTrailingSample(sample, tempScale)) {
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
    }

    const catchingUp = isCatchingUp(oven, tempScale)
    const fullPower = isFullPower(oven)
    const targetDelta = Number.isFinite(target) && Number.isFinite(temp) ? target - temp : null

    if (!catchingUp) {
      delayRef.current = 0
      setEta(remainingS)
    } else if (fullPowerSinceFitRef.current >= FULL_POWER_SAMPLE_WINDOW) {
      curveRef.current = buildCurve(rateSamplesRef.current, tempScale)
      fullPowerSinceFitRef.current = 0
      lastFitAtRef.current = Date.now()
      if (curveRef.current && backlog?.profile?.data && runtimeS !== null && Number.isFinite(runtimeS)) {
        delayRef.current = computeCatchUpDelay({
          profile: backlog.profile.data,
          runtimeS,
          currentTemp: temp,
          curve: curveRef.current,
          tempScale,
        })
      }
    }

    if (remainingS !== null) {
      setEta(remainingS + delayRef.current)
    } else {
      setEta(null)
    }

    setDebug({
      catchingUp,
      fullPower,
      pidOut: pidOutFromOven(oven),
      targetDelta,
      samples: samplesRef.current.length,
      rateSamples: rateSamplesRef.current.length,
      fullPowerSinceFit: fullPowerSinceFitRef.current,
      curveBins: curveRef.current?.temps.length ?? 0,
      delayS: delayRef.current,
      lastFitAtMs: lastFitAtRef.current,
      profilePoints: backlog?.profile?.data?.length ?? 0,
    })
  }, [oven, backlog, runtimeS, elapsedS, remainingS, tempScale])

  return { eta, debug }
}
