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

function formatNumber(v: number | null | undefined): string {
  if (v === null || v === undefined) return '--'
  return Number.isFinite(v) ? v.toFixed(1) : '--'
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

function App() {
  const status = useStatusWs()

  return (
    <main className="app">
      <header className="top">
        <div>
          <div className="kicker">Kiln Controller</div>
          <h1 className="title">New UI (Preview)</h1>
        </div>
        <div className={`pill pillStatus pillStatus--${status.connection}`} role="note" aria-label="Status">
          <span className="dot" aria-hidden="true" />
          {connectionLabel(status.connection)}
        </div>
      </header>

      <section className="grid" aria-label="Cards">
        <article className="card">
          <h2>Live Status</h2>
          <p className="muted">
            WebSocket: <code>{status.urlPath}</code>
          </p>

          <div className="statusGrid" aria-label="Connection info">
            <div className="kv compact">
              <div className="k">Conn</div>
              <div className="v">{connectionLabel(status.connection)}</div>
            </div>
            <div className="kv compact">
              <div className="k">Last msg</div>
              <div className="v">{formatTime(status.lastMessageAt)}</div>
            </div>
            <div className="kv compact">
              <div className="k">Age</div>
              <div className="v">{formatAgeMs(status.lastMessageAgeMs)}</div>
            </div>
            <div className="kv compact">
              <div className="k">Valid</div>
              <div className="v">{status.lastMessageValid ? 'yes' : 'no'}</div>
            </div>
          </div>

          <div className="statusGrid" aria-label="Latest state">
            <div className="kv compact">
              <div className="k">State</div>
              <div className="v">{status.state?.state ?? '--'}</div>
            </div>
            <div className="kv compact">
              <div className="k">Temp</div>
              <div className="v">{formatNumber(status.state?.temperature)}&deg;</div>
            </div>
            <div className="kv compact">
              <div className="k">Target</div>
              <div className="v">{formatNumber(status.state?.target)}&deg;</div>
            </div>
            <div className="kv compact">
              <div className="k">Profile</div>
              <div className="v">{status.state?.profile ?? '--'}</div>
            </div>
          </div>

          {status.lastParseError ? <p className="muted">Parse warning: {status.lastParseError}</p> : null}
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
