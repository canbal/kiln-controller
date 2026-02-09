import { useEffect, useMemo, useState } from 'react'
import { apiListSessions } from '../api/sessions'
import type { Session } from '../contract/sessions'
import { appHref } from '../router'

function fmtDateTime(tsSec: number | null | undefined): string {
  if (typeof tsSec !== 'number' || !Number.isFinite(tsSec)) return '--'
  const d = new Date(tsSec * 1000)
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtDurationSec(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '--'
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function computeDurationS(s: Session): number | null {
  const start = typeof s.started_at === 'number' ? s.started_at : null
  const end = typeof s.ended_at === 'number' ? s.ended_at : null
  if (start === null || end === null) return null
  const dur = end - start
  return Number.isFinite(dur) ? Math.max(0, dur) : null
}

function notePreview(notes: unknown): string | null {
  if (typeof notes !== 'string') return null
  const trimmed = notes.trim()
  if (!trimmed) return null
  const oneLine = trimmed.replace(/\s+/g, ' ')
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine
}

function hasOwn(obj: unknown, key: string): boolean {
  if (!obj || typeof obj !== 'object') return false
  return Object.prototype.hasOwnProperty.call(obj, key)
}

export function SessionsListPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    let cancelled = false

    const run = async () => {
      setLoading(true)
      setError(null)
      const res = await apiListSessions({ limit: 100, offset: 0, signal: ac.signal })
      if (!res.ok) {
        if (cancelled || res.error === 'aborted') return
        setError(res.error)
        setSessions([])
        setLoading(false)
        return
      }
      if (cancelled) return
      setSessions(res.value)
      setLoading(false)
    }

    run().catch((e) => {
      if (cancelled) return
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'aborted' || msg.toLowerCase().includes('signal is aborted') || msg.includes('AbortError')) return
      setError(e instanceof Error ? e.message : String(e))
      setSessions([])
      setLoading(false)
    })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [refreshToken])

  const rows = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    return sorted
  }, [sessions])

  return (
    <section className="sessions" aria-label="Sessions">
      <div className="pageHead">
        <div>
          <h2 className="pageTitle">Firing Sessions</h2>
          <div className="pageSub muted">Browse and annotate past firings.</div>
        </div>
        <button type="button" className="btn" onClick={() => setRefreshToken((x) => x + 1)}>
          Refresh
        </button>
      </div>

      {loading ? <p className="muted">Loading sessions…</p> : null}
      {error ? <p className="muted">Error: {error}</p> : null}
      {!loading && !error && rows.length === 0 ? <p className="muted">No sessions yet.</p> : null}

      <div className="sessionList" role="list">
        {rows.map((s) => {
          const dur = computeDurationS(s)
          const sObj = s as unknown
          const notesKeyPresent = hasOwn(sObj, 'notes')
          const notes = notePreview(notesKeyPresent ? (s as Record<string, unknown>).notes : undefined)
          const outcome = typeof s.outcome === 'string' && s.outcome ? s.outcome : '--'
          const when = typeof s.started_at === 'number' ? s.started_at : s.created_at
          return (
            <a
              key={s.id}
              className="sessionRow"
              role="listitem"
              href={appHref(`/sessions/${encodeURIComponent(s.id)}`)}
              aria-label={`Session ${s.id}`}
            >
              <div className="sessionRowTop">
                <div className="sessionRowTitle">
                  <span className="sessionProfile">{s.profile_name ?? 'Unnamed profile'}</span>
                  <span className="sessionOutcome">{outcome}</span>
                </div>
                <div className="sessionMeta muted">{fmtDateTime(when)}</div>
              </div>
              <div className="sessionRowBottom">
                <div className="sessionMeta muted">Duration: {fmtDurationSec(dur)}</div>
                {notes ? (
                  <div className="sessionNotes">{notes}</div>
                ) : notesKeyPresent ? (
                  <div className="sessionNotes sessionNotes--empty">No notes</div>
                ) : (
                  <div className="sessionNotes sessionNotes--empty">Open to view/edit notes</div>
                )}
              </div>
            </a>
          )
        })}
      </div>
    </section>
  )
}
