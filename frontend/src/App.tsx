import './App.css'
import { useStatusWs } from './ws/status'

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
  const oven = status.state
  const running = oven?.state === 'RUNNING'

  return (
    <main className="app">
      <header className="top">
        <div>
          <div className="kicker">Kiln Controller</div>
          <h1 className="title">Dashboard</h1>
        </div>
        <div className={`pill pillStatus pillStatus--${status.connection}`} role="note" aria-label="Status">
          <span className="dot" aria-hidden="true" />
          {connectionLabel(status.connection)}
        </div>
      </header>

      <section className="grid" aria-label="Cards">
        <article className="card card--span2" aria-label="Metrics">
          <h2>Live Metrics</h2>

          <div className="metricsHero">
            <div className="metricsTemp" aria-label="Current temperature">
              <div className="tempValue">
                {formatTemp(oven?.temperature)}
                <span className="tempUnit">&deg;</span>
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
                <span className="tileUnit">&deg;</span>
              </div>
            </div>

            <div className="tile">
              <div className="tileLabel">Power</div>
              <div className="tileValue">{formatPowerPct(oven)}%</div>
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
