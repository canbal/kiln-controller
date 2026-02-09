import './App.css'

function App() {
  return (
    <main className="app">
      <header className="top">
        <div>
          <div className="kicker">Kiln Controller</div>
          <h1 className="title">New UI (Preview)</h1>
        </div>
        <div className="pill" role="note" aria-label="Status">
          Work in progress
        </div>
      </header>

      <section className="grid" aria-label="Cards">
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
