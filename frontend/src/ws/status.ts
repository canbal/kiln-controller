import { useEffect, useMemo, useRef, useState } from 'react'
import type { OvenState, StatusBacklogEnvelope } from '../contract/status'
import { parseStatusWsMessage } from '../contract/status'

type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'

type UseStatusWsResult = {
  urlPath: string
  connection: ConnectionState
  lastMessageAt: Date | null
  lastMessageAgeMs: number | null
  lastMessageValid: boolean
  lastParseError: string | null
  state: OvenState | null
  backlog: StatusBacklogEnvelope | null
}

function wsUrlForPath(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${path}`
}

function computeReconnectDelayMs(attempt: number): number {
  // Exponential backoff with jitter.
  // attempt=0 -> ~500ms; grows to max ~30s.
  const base = 500
  const max = 30_000
  const exp = Math.min(max, base * Math.pow(2, attempt))
  const jitter = exp * (0.2 + Math.random() * 0.6) // 20%-80%
  return Math.round(jitter)
}

export function useStatusWs(path = '/status'): UseStatusWsResult {
  const url = useMemo(() => wsUrlForPath(path), [path])

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const staleTimerRef = useRef<number | null>(null)
  const ageTimerRef = useRef<number | null>(null)
  const attemptRef = useRef(0)

  const lastMessageAtRef = useRef<Date | null>(null)

  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [lastMessageAt, setLastMessageAt] = useState<Date | null>(null)
  const [lastMessageAgeMs, setLastMessageAgeMs] = useState<number | null>(null)
  const [lastMessageValid, setLastMessageValid] = useState(true)
  const [lastParseError, setLastParseError] = useState<string | null>(null)
  const [state, setState] = useState<OvenState | null>(null)
  const [backlog, setBacklog] = useState<StatusBacklogEnvelope | null>(null)

  useEffect(() => {
    let cancelled = false

    const clearTimers = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (staleTimerRef.current !== null) {
        window.clearInterval(staleTimerRef.current)
        staleTimerRef.current = null
      }
      if (ageTimerRef.current !== null) {
        window.clearInterval(ageTimerRef.current)
        ageTimerRef.current = null
      }
    }

    const closeSocket = (code: number, reason: string) => {
      const ws = wsRef.current
      wsRef.current = null
      if (!ws) return
      try {
        ws.onopen = null
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason)
        }
      } catch {
        // ignore
      }
    }

    const scheduleReconnect = () => {
      if (cancelled) return
      if (reconnectTimerRef.current !== null) return

      const attempt = attemptRef.current
      const delay = computeReconnectDelayMs(attempt)
      attemptRef.current = Math.min(attempt + 1, 20)

      setConnection((prev) => (prev === 'open' ? 'reconnecting' : prev === 'connecting' ? 'connecting' : 'reconnecting'))
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, delay)
    }

    const connect = () => {
      if (cancelled) return

      // If an existing socket is active, don't start a second one.
      const existing = wsRef.current
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return
      }

      setConnection((prev) => (prev === 'open' ? 'reconnecting' : 'connecting'))

      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (err) {
        setConnection('error')
        setLastParseError(err instanceof Error ? err.message : String(err))
        scheduleReconnect()
        return
      }

      wsRef.current = ws

      ws.onopen = () => {
        if (cancelled || wsRef.current !== ws) return
        attemptRef.current = 0
        setConnection('open')
        setLastParseError(null)
      }

      ws.onerror = () => {
        if (cancelled || wsRef.current !== ws) return
        // The close handler will follow in many cases.
        setConnection('error')
      }

      ws.onclose = () => {
        if (cancelled || wsRef.current !== ws) return
        wsRef.current = null
        setConnection('closed')
        scheduleReconnect()
      }

      ws.onmessage = (ev) => {
        if (cancelled || wsRef.current !== ws) return

        let json: unknown
        try {
          json = JSON.parse(String(ev.data))
        } catch {
          setLastMessageValid(false)
          setLastParseError('Message was not valid JSON')
          return
        }

        try {
          const msg = parseStatusWsMessage(json)
          setLastMessageValid(true)
          setLastParseError(null)

          if (msg.kind === 'backlog') {
            setBacklog(msg.value)
            const newest = msg.value.log.at(-1)
            if (newest) setState(newest)
          } else {
            setState(msg.value)
          }

          const now = new Date()
          lastMessageAtRef.current = now
          setLastMessageAt(now)
          setLastMessageAgeMs(0)
        } catch (err) {
          setLastMessageValid(false)
          setLastParseError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    const forceReconnectIfNeeded = () => {
      if (cancelled) return

      const ws = wsRef.current
      if (!ws) {
        connect()
        return
      }

      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        wsRef.current = null
        connect()
        return
      }

      // If we're visible and haven't received a message in a while, reconnect.
      const lastAt = lastMessageAtRef.current
      const ageMs = lastAt ? Date.now() - lastAt.getTime() : null
      const visible = document.visibilityState === 'visible'
      const stale = visible && ageMs !== null && ageMs > 15_000
      if (stale) {
        closeSocket(4000, 'stale')
        scheduleReconnect()
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        forceReconnectIfNeeded()
      }
    }

    const onOnline = () => {
      forceReconnectIfNeeded()
    }

    const onFocus = () => {
      forceReconnectIfNeeded()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onFocus)

    // Keep the displayed age fresh without calling Date.now() during render.
    ageTimerRef.current = window.setInterval(() => {
      const at = lastMessageAtRef.current
      setLastMessageAgeMs(at ? Date.now() - at.getTime() : null)
    }, 1000)

    // Periodic stale detection (helps with tab sleep or lost TCP).
    staleTimerRef.current = window.setInterval(() => {
      forceReconnectIfNeeded()
    }, 5_000)

    connect()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onFocus)
      clearTimers()
      closeSocket(1000, 'unmount')
    }
  }, [url])

  return {
    urlPath: path,
    connection,
    lastMessageAt,
    lastMessageAgeMs,
    lastMessageValid,
    lastParseError,
    state,
    backlog,
  }
}
