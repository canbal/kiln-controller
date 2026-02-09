import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigEnvelope, TempScale } from '../contract/config'
import { parseConfigWsMessage, parseTempScale } from '../contract/config'

type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'

type UseConfigWsResult = {
  urlPath: string
  connection: ConnectionState
  lastMessageAt: Date | null
  lastMessageValid: boolean
  lastParseError: string | null
  config: ConfigEnvelope | null
  tempScale: TempScale | null
}

function wsUrlForPath(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${path}`
}

function computeReconnectDelayMs(attempt: number): number {
  const base = 500
  const max = 30_000
  const exp = Math.min(max, base * Math.pow(2, attempt))
  const jitter = exp * (0.2 + Math.random() * 0.6)
  return Math.round(jitter)
}

export function useConfigWs(path = '/config'): UseConfigWsResult {
  const url = useMemo(() => wsUrlForPath(path), [path])

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const attemptRef = useRef(0)
  const pollTimerRef = useRef<number | null>(null)

  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [lastMessageAt, setLastMessageAt] = useState<Date | null>(null)
  const [lastMessageValid, setLastMessageValid] = useState(true)
  const [lastParseError, setLastParseError] = useState<string | null>(null)
  const [config, setConfig] = useState<ConfigEnvelope | null>(null)
  const [tempScale, setTempScale] = useState<TempScale | null>(null)

  useEffect(() => {
    let cancelled = false

    const clearTimers = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
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

    const requestConfig = () => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        // Server replies to any received message.
        ws.send('GET')
      } catch {
        // ignore
      }
    }

    const connect = () => {
      if (cancelled) return

      const existing = wsRef.current
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return

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
        requestConfig()
        if (pollTimerRef.current === null) {
          pollTimerRef.current = window.setInterval(() => requestConfig(), 10_000)
        }
      }

      ws.onerror = () => {
        if (cancelled || wsRef.current !== ws) return
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
          const cfg = parseConfigWsMessage(json)
          setConfig(cfg)
          setTempScale(parseTempScale(cfg.temp_scale))
          setLastMessageValid(true)
          setLastParseError(null)
          setLastMessageAt(new Date())
        } catch (err) {
          setLastMessageValid(false)
          setLastParseError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimers()
      closeSocket(1000, 'unmount')
    }
  }, [url])

  return {
    urlPath: path,
    connection,
    lastMessageAt,
    lastMessageValid,
    lastParseError,
    config,
    tempScale,
  }
}
