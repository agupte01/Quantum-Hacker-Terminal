/**
 * wsClient.js — WebSocket manager for the Quantum Hacker Terminal.
 *
 * Maintains a single persistent connection per session.  Subscribers register
 * handler functions for specific event types; the client dispatches inbound
 * messages to all matching handlers.
 *
 * Reconnection: if the socket drops unexpectedly we attempt to reconnect with
 * exponential back-off (up to 30 s) so the user does not lose their session
 * context.
 *
 * Usage:
 *   const ws = new WSClient(sessionId)
 *   ws.on('statevector', handler)
 *   ws.on('shor_step',   handler)
 *   ws.connect()
 *   // later:
 *   ws.disconnect()
 */

const WS_BASE = `ws://${window.location.hostname}:8000/ws`

const MAX_BACKOFF_MS = 30_000

export class WSClient {
  constructor(sessionId) {
    this._sessionId  = sessionId
    this._socket     = null
    this._handlers   = {}        // eventType → [fn, ...]
    this._backoff    = 1000
    this._intentional = false
    this._pingInterval = null
  }

  // ---- Lifecycle ----------------------------------------------------------

  connect() {
    this._intentional = false
    this._open()
  }

  disconnect() {
    this._intentional = true
    clearInterval(this._pingInterval)
    if (this._socket) {
      this._socket.close()
      this._socket = null
    }
  }

  // ---- Subscription -------------------------------------------------------

  /** Register a handler for a specific event type (or '*' for all). */
  on(eventType, handler) {
    if (!this._handlers[eventType]) this._handlers[eventType] = []
    this._handlers[eventType].push(handler)
    return () => this.off(eventType, handler)   // returns an unsubscribe fn
  }

  off(eventType, handler) {
    if (!this._handlers[eventType]) return
    this._handlers[eventType] = this._handlers[eventType].filter(h => h !== handler)
  }

  // ---- Internal -----------------------------------------------------------

  _open() {
    const url = `${WS_BASE}/${this._sessionId}`
    const ws  = new WebSocket(url)
    this._socket = ws

    ws.onopen = () => {
      this._backoff = 1000      // reset back-off on successful connect
      this._startPing()
      this._emit('__connected', {})
    }

    ws.onmessage = (evt) => {
      // The server sends JSON objects; raw "pong" strings are keepalive replies
      if (evt.data === 'pong') return

      let msg
      try {
        msg = JSON.parse(evt.data)
      } catch {
        return
      }

      const { type, data } = msg
      this._emit(type, data)
      this._emit('*', msg)       // wildcard subscribers receive everything
    }

    ws.onclose = () => {
      clearInterval(this._pingInterval)
      this._emit('__disconnected', {})
      if (!this._intentional) {
        setTimeout(() => this._open(), this._backoff)
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS)
      }
    }

    ws.onerror = () => {
      // onclose fires immediately after onerror, so we only log here
      this._emit('__error', { message: 'WebSocket error' })
    }
  }

  _startPing() {
    clearInterval(this._pingInterval)
    // Keep the connection alive through proxies and load balancers
    this._pingInterval = setInterval(() => {
      if (this._socket?.readyState === WebSocket.OPEN) {
        this._socket.send('ping')
      }
    }, 20_000)
  }

  _emit(type, data) {
    const fns = this._handlers[type]
    if (fns) fns.forEach(fn => fn(data))
  }
}
