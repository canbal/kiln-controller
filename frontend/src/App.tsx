import './App.css'
import { useEffect, useState } from 'react'
import { useStatusWs } from './ws/status'
import { useConfigWs } from './ws/config'
import { LiveTempChart } from './components/LiveTempChart'
import { RecentSessionChart } from './components/RecentSessionChart'
import { apiGetTheme, apiSetTheme } from './api/settings'
import type { UiTheme } from './api/settings'

function formatTime(d: Date | null): string {
  if (!d) return 'never'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatAgeMs(ms: number | null): string {
  if (ms === null) return 'n/a'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}

function formatTemp(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--'
  if (!Number.isFinite(v)) return '--'

  // Small-screen readability: show a whole number by default.
  return String(Math.round(v))
}

function formatPowerPct(oven: { heat?: number | null; pidstats?: Record<string, number> | null } | null): string {
  const out = oven?.pidstats && typeof oven.pidstats.out === 'number' ? oven.pidstats.out : null
  if (out !== null && Number.isFinite(out)) {
    return String(Math.round(out * 100))
  }

  const heat = oven?.heat ?? null
  if (heat === null || heat === undefined) return '--'
  if (!Number.isFinite(heat)) return '--'

  // Contract notes:
  // - real oven: heat is 0.0 or 1.0
  // - simulated: heat is seconds-on during the last control window
  // In both cases, with the default 1s control window, 1.0 means 100%.
  if (heat >= 0 && heat <= 1.2) return String(Math.round(heat * 100))
  if (heat > 1.2 && heat <= 100) return String(Math.round(heat))
  return '--'
}

function formatDurationSeconds(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--'
  if (!Number.isFinite(v)) return '--'
  const total = Math.max(0, Math.floor(v))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function computeProgressPct(runtimeS: number | null, totalS: number | null): number | null {
  if (runtimeS === null || totalS === null) return null
  if (!Number.isFinite(runtimeS) || !Number.isFinite(totalS)) return null
  if (!(totalS > 0)) return null
  const raw = (runtimeS / totalS) * 100
  if (!Number.isFinite(raw)) return null
  return Math.max(0, Math.min(100, raw))
}

function connectionLabel(s: string): string {
  switch (s) {
    case 'open':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'reconnecting':
      return 'Reconnecting'
    case 'closed':
      return 'Closed'
    case 'error':
      return 'Error'
    default:
      return s
  }
}

function stateLabel(s: string | null | undefined): string {
  if (!s) return '--'
  switch (s) {
    case 'RUNNING':
      return 'RUNNING'
    case 'IDLE':
      return 'IDLE'
    default:
      return s
  }
}

function App() {
  const status = useStatusWs()
  const cfg = useConfigWs()
  const oven = status.state
  const running = oven?.state === 'RUNNING'
  const unit = cfg.tempScale === 'c' ? 'C' : cfg.tempScale === 'f' ? 'F' : ''

  const [theme, setTheme] = useState<UiTheme>('stoneware')
  const [themeErr, setThemeErr] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    apiGetTheme({ signal: ac.signal }).then((res) => {
      if (!res.ok) {
        setThemeErr(res.error)
        return
      }
      setTheme(res.value)
    })
    return () => ac.abort()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toggleTheme = async () => {
    const next: UiTheme = theme === 'dark' ? 'stoneware' : 'dark'
    setTheme(next)
    setThemeErr(null)
    const res = await apiSetTheme(next)
    if (!res.ok) {
      setThemeErr(res.error)
      // best-effort rollback to the previous theme
      setTheme(theme)
      return
    }
    setTheme(res.value)
  }

  const isDark = theme === 'dark'

  const runtimeS = oven && Number.isFinite(oven.runtime) ? oven.runtime : null
  const wallElapsedS = oven && typeof oven.elapsed === 'number' && Number.isFinite(oven.elapsed) ? oven.elapsed : null
  const totalS = oven && Number.isFinite(oven.totaltime) ? oven.totaltime : null
  const progressPct = running ? computeProgressPct(runtimeS, totalS) : null
  const remainingS = running && runtimeS !== null && totalS !== null ? Math.max(0, totalS - runtimeS) : null
  const estRemainingS =
    running && runtimeS !== null && runtimeS > 0 && wallElapsedS !== null && remainingS !== null
      ? (wallElapsedS / runtimeS) * remainingS
      : null

  const cooldownActive = oven?.cooldown_active === true
  const cooldownElapsedS =
    cooldownActive && typeof oven?.cooldown_elapsed === 'number' && Number.isFinite(oven.cooldown_elapsed)
      ? oven.cooldown_elapsed
      : null

  return (
    <main className="app">
      <header className="top">
        <div>
          <div className="kicker">Kiln Controller</div>
          <h1 className="title">Dashboard</h1>
        </div>
        <div className="topRight">
          <div className={`pill pillStatus pillStatus--${status.connection}`} role="note" aria-label="Status">
            <span className="dot" aria-hidden="true" />
            {connectionLabel(status.connection)}
          </div>
          <button
            type="button"
            className="pill themeToggle"
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-pressed={isDark}
            onClick={toggleTheme}
            title={isDark ? 'Light theme' : 'Dark theme'}
          >
            <span className="themeIcon" aria-hidden="true">
              {isDark ? (
                // Moon (dark mode)
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path
                    fill="currentColor"
                    d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z"
                  />
                </svg>
              ) : (
                // Sun (light mode)
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path
                    fill="currentColor"
                    d="M12 18a6 6 0 1 1 0-12 6 6 0 0 1 0 12Zm0-14.5a1 1 0 0 1 1 1V5a1 1 0 1 1-2 0V4.5a1 1 0 0 1 1-1Zm0 15.5a1 1 0 0 1 1 1V20a1 1 0 1 1-2 0v-.5a1 1 0 0 1 1-1ZM4.5 11a1 1 0 0 1 1 1 1 1 0 0 1-1 1H4a1 1 0 1 1 0-2h.5Zm15.5 0a1 1 0 0 1 1 1 1 1 0 0 1-1 1H19a1 1 0 1 1 0-2h1Zm-2.23-6.77a1 1 0 0 1 1.41 0l.36.36a1 1 0 1 1-1.41 1.41l-.36-.36a1 1 0 0 1 0-1.41ZM5.46 16.54a1 1 0 0 1 1.41 0l.36.36a1 1 0 1 1-1.41 1.41l-.36-.36a1 1 0 0 1 0-1.41Zm13.72 1.77a1 1 0 0 1 0 1.41l-.36.36a1 1 0 1 1-1.41-1.41l.36-.36a1 1 0 0 1 1.41 0ZM6.87 5.64a1 1 0 0 1 0 1.41l-.36.36A1 1 0 0 1 5.1 6l.36-.36a1 1 0 0 1 1.41 0Z"
                  />
                </svg>
              )}
            </span>
          </button>
        </div>
      </header>

      <section className="grid" aria-label="Cards">
        <article className="card card--span2" aria-label="Metrics">
          <h2>Live Metrics</h2>

          <div className="metricsHero">
            <div className="metricsTemp" aria-label="Current temperature">
              <div className="tempValue">
                {formatTemp(oven?.temperature)}
                <span className="tempUnit">&deg;{unit}</span>
              </div>
              <div className="tempMeta">
                {status.connection === 'open' ? (
                  <span>
                    last update {formatAgeMs(status.lastMessageAgeMs)} ago
                    {status.lastMessageValid ? '' : ' (invalid)'}
                  </span>
                ) : (
                  <span>waiting for data from {status.urlPath}</span>
                )}
              </div>
            </div>

            <div className={`badge ${running ? 'badge--running' : 'badge--idle'}`} aria-label="Oven state">
              {stateLabel(oven?.state)}
            </div>
          </div>

          <div className="metricsTiles" aria-label="Secondary metrics">
            <div className="tile">
              <div className="tileLabel">Target</div>
              <div className="tileValue">
                {formatTemp(oven?.target)}
                <span className="tileUnit">&deg;{unit}</span>
              </div>
            </div>

            <div className="tile">
              <div className="tileLabel">Power</div>
              <div className="tileValue">{formatPowerPct(oven)}%</div>
            </div>

            <div className="tile">
              <div className="tileLabel">Progress</div>
              <div className="tileValue">{progressPct === null ? '--' : `${Math.round(progressPct)}%`}</div>
            </div>

            <div className="tile">
              <div className="tileLabel">Runtime</div>
              <div className="tileValue tileValue--mono">{formatDurationSeconds(running ? runtimeS : null)}</div>
            </div>

            <div className="tile">
              <div className="tileLabel">Elapsed</div>
              <div className="tileValue tileValue--mono">{formatDurationSeconds(running ? wallElapsedS : null)}</div>
            </div>

            <div className="tile">
              <div className="tileLabel">Remaining</div>
              <div className="tileValue tileValue--mono">{formatDurationSeconds(remainingS)}</div>
            </div>

            <div className="tile">
              <div className="tileLabel">Est remaining</div>
              <div className="tileValue tileValue--mono">{formatDurationSeconds(estRemainingS)}</div>
            </div>

            <div className="tile">
              <div className="tileLabel">Cooldown</div>
              <div className="tileValue tileValue--mono">
                {cooldownActive ? formatDurationSeconds(cooldownElapsedS) : '--'}
              </div>
            </div>

            <div className="tile tile--wide">
              <div className="tileLabel">Profile</div>
              <div className="tileValue tileValue--text">{oven?.profile ?? '--'}</div>
            </div>
          </div>

          {status.lastParseError ? <p className="muted">Parse warning: {status.lastParseError}</p> : null}

          <div className="statusStrip" aria-label="Connection details">
            <div className="stripItem">
              <span className="stripK">Conn</span>
              <span className="stripV">{connectionLabel(status.connection)}</span>
            </div>
            <div className="stripItem">
              <span className="stripK">Last msg</span>
              <span className="stripV">{formatTime(status.lastMessageAt)}</span>
            </div>
            <div className="stripItem">
              <span className="stripK">Valid</span>
              <span className="stripV">{status.lastMessageValid ? 'yes' : 'no'}</span>
            </div>
          </div>
        </article>

        <article className="card card--span2" aria-label="Chart">
          <div className="cardHead">
            <h2>Live Temperature</h2>
            <div className="cardHeadMeta muted">Actual + target (when RUNNING)</div>
          </div>
          <LiveTempChart state={status.state} backlog={status.backlog} tempScale={cfg.tempScale} theme={theme} />
          <p className="muted chartHint">Scroll/2-finger to pan. Pinch (or ctrl+scroll) to zoom. Drag to pan.</p>
          {themeErr ? <p className="muted">Theme save error: {themeErr}</p> : null}
        </article>

        <article className="card card--span2" aria-label="Recent session chart">
          <div className="cardHead">
            <h2>Most Recent Session</h2>
            <div className="cardHeadMeta muted">Cooling tail + end marker</div>
          </div>
          <RecentSessionChart tempScale={cfg.tempScale} theme={theme} />
        </article>

        <article className="card">
          <h2>What this is</h2>
          <p>
            A React + TypeScript shell served from <code>/app</code>. It is intentionally additive and
            does not change any legacy endpoints.
          </p>
          <p className="muted">
            Safety note: until further milestones, this UI is read-only and should not be relied on to
            run or stop a firing.
          </p>
        </article>

        <article className="card">
          <h2>Legacy UI</h2>
          <p>The existing control surface remains at <code>/picoreflow</code>.</p>
          <div className="actions">
            <a className="btn primary" href="/picoreflow/index.html">
              Open legacy UI
            </a>
            <a className="btn" href="/">
              Go to /
            </a>
          </div>
        </article>

        <article className="card">
          <h2>Next steps</h2>
          <ol className="list">
            <li>WebSocket client for <code>/status</code> with reconnect + validation.</li>
            <li>Mobile-first dashboard metrics.</li>
            <li>Live chart with target + actual temperature.</li>
          </ol>
        </article>

        <article className="card">
          <h2>Dev</h2>
          <p className="muted">
            This app is built into <code>public/app/</code> so the kiln can deploy via <code>git pull</code>{' '}
            + restart.
          </p>
          <div className="kv">
            <div className="k">Origin</div>
            <div className="v">{window.location.origin}</div>
          </div>
          <div className="kv">
            <div className="k">Path</div>
            <div className="v">{window.location.pathname}</div>
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
