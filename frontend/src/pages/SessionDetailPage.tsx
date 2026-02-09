import { useEffect, useMemo, useState } from 'react'
import { apiGetSession, apiPatchSessionNotes } from '../api/sessions'
import type { Session } from '../contract/sessions'
import { appHref } from '../router'

function fmtDateTime(tsSec: number | null | undefined): string {
  if (typeof tsSec !== 'number' || !Number.isFinite(tsSec)) return '--'
  const d = new Date(tsSec * 1000)
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function computeDurationS(s: Session): number | null {
  const start = typeof s.started_at === 'number' ? s.started_at : null
  const end = typeof s.ended_at === 'number' ? s.ended_at : null
  if (start === null || end === null) return null
  const dur = end - start
  return Number.isFinite(dur) ? Math.max(0, dur) : null
}

function fmtDurationSec(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '--'
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function normalizeNotes(v: string | null): string {
  return v ?? ''
}

export function SessionDetailPage(props: { sessionId: string }) {
  const sessionId = props.sessionId
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  const [draftNotes, setDraftNotes] = useState('')
  const [savedNotes, setSavedNotes] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [justSavedAt, setJustSavedAt] = useState<number | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    let cancelled = false

    const run = async () => {
      setLoading(true)
      setError(null)
      setSaveError(null)
      setJustSavedAt(null)

      const res = await apiGetSession({ sessionId, signal: ac.signal })
      if (!res.ok) {
        if (cancelled || res.error === 'aborted') return
        setError(res.error)
        setSession(null)
        setLoading(false)
        return
      }

      if (cancelled) return
      setSession(res.value)
      const notes = (res.value as Record<string, unknown>).notes
      const notesStr = typeof notes === 'string' ? notes : null
      setSavedNotes(notesStr)
      setDraftNotes(normalizeNotes(notesStr))
      setLoading(false)
    }

    run().catch((e) => {
      if (cancelled) return
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'aborted' || msg.toLowerCase().includes('signal is aborted') || msg.includes('AbortError')) return
      setError(e instanceof Error ? e.message : String(e))
      setSession(null)
      setLoading(false)
    })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [sessionId])

  const maxLen = 5000
  const tooLong = draftNotes.length > maxLen
  const dirty = normalizeNotes(savedNotes) !== draftNotes

  const durationLabel = useMemo(() => {
    if (!session) return '--'
    return fmtDurationSec(computeDurationS(session))
  }, [session])

  const save = async () => {
    if (saving) return
    setSaveError(null)
    setJustSavedAt(null)
    setSaving(true)
    try {
      const payloadNotes = draftNotes.length === 0 ? null : draftNotes
      const res = await apiPatchSessionNotes({ sessionId, notes: payloadNotes })
      if (!res.ok) {
        setSaveError(res.error)
        setSaving(false)
        return
      }
      setSession(res.value)
      const notes = (res.value as Record<string, unknown>).notes
      const notesStr = typeof notes === 'string' ? notes : null
      setSavedNotes(notesStr)
      setDraftNotes(normalizeNotes(notesStr))
      setJustSavedAt(Date.now())
      setSaving(false)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const saveStatus = useMemo(() => {
    if (saving) return 'Saving…'
    if (saveError) return 'Save failed'
    if (justSavedAt) return 'Saved'
    if (dirty) return 'Unsaved'
    return 'Saved'
  }, [saving, saveError, justSavedAt, dirty])

  return (
    <section className="sessionDetail" aria-label="Session detail">
      <div className="pageHead">
        <div className="crumbs">
          <a className="crumbLink" href={appHref('/sessions')}>
            Sessions
          </a>
          <span className="crumbSep" aria-hidden="true">
            /
          </span>
          <span className="crumbHere">Detail</span>
        </div>
        <a className="btn" href={appHref('/sessions')}>
          Back
        </a>
      </div>

      {loading ? <p className="muted">Loading session…</p> : null}
      {error ? <p className="muted">Error: {error}</p> : null}
      {!loading && !error && !session ? <p className="muted">Session not found.</p> : null}

      {session ? (
        <>
          <article className="card" aria-label="Session metadata">
            <h2>Session</h2>
            <div className="sessionMetaGrid">
              <div className="kv compact">
                <div className="k">Profile</div>
                <div className="v">{session.profile_name ?? '--'}</div>
              </div>
              <div className="kv compact">
                <div className="k">Outcome</div>
                <div className="v">{session.outcome ?? '--'}</div>
              </div>
              <div className="kv compact">
                <div className="k">Started</div>
                <div className="v">{fmtDateTime(session.started_at)}</div>
              </div>
              <div className="kv compact">
                <div className="k">Ended</div>
                <div className="v">{fmtDateTime(session.ended_at)}</div>
              </div>
              <div className="kv compact">
                <div className="k">Duration</div>
                <div className="v">{durationLabel}</div>
              </div>
              <div className="kv compact">
                <div className="k">Id</div>
                <div className="v">
                  <code>{session.id}</code>
                </div>
              </div>
            </div>
          </article>

          <article className="card" aria-label="Session notes">
            <div className="notesHead">
              <h2>Notes</h2>
              <div className={`pill notesStatus ${saveError ? 'notesStatus--error' : dirty ? 'notesStatus--dirty' : ''}`}>
                {saveStatus}
              </div>
            </div>

            <textarea
              className={`notesBox ${tooLong ? 'notesBox--error' : ''}`}
              value={draftNotes}
              onChange={(e) => {
                setDraftNotes(e.target.value)
                setJustSavedAt(null)
                setSaveError(null)
              }}
              placeholder="Add firing notes… (clay body, cone, soak, issues, results)"
              rows={10}
              maxLength={maxLen + 200}
            />

            <div className="notesFoot">
              <div className={`muted ${tooLong ? 'notesWarn' : ''}`}>{draftNotes.length}/{maxLen}</div>
              <button type="button" className="btn primary" disabled={!dirty || saving || tooLong} onClick={save}>
                Save notes
              </button>
            </div>

            {tooLong ? <p className="muted">Notes are too long (max {maxLen} characters).</p> : null}
            {saveError ? <p className="muted">Save error: {saveError}</p> : null}
            <p className="muted">
              Notes are stored locally in the kiln database via <code>PATCH /v1/sessions/:id</code>.
            </p>
          </article>
        </>
      ) : null}
    </section>
  )
}
