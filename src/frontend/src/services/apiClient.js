/**
 * apiClient.js — thin wrapper around the Fetch API for REST calls to
 * the FastAPI backend.
 *
 * All paths are relative so they work both through the Vite proxy
 * (development) and from the same origin (production).
 */

const BASE = '/api'

async function _post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

async function _get(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a new session and return its UUID. */
export async function newSession() {
  const data = await _post('/session/new', {})
  return data.session_id
}

/**
 * Send a terminal command to the backend.
 * Returns { success, lines, statevector, circuit_ops, histogram }
 */
export async function sendCommand(sessionId, command) {
  return _post('/command', { session_id: sessionId, command })
}

/**
 * Fetch all statevector snapshots for playback mode.
 * Returns { snapshots: [{statevector, circuit_ops}, ...] }
 */
export async function getSnapshots(sessionId) {
  return _get(`/session/${sessionId}/snapshots`)
}
