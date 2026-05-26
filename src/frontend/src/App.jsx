/**
 * App.jsx — Root component for the Quantum Hacker Terminal.
 *
 * Owns all shared state (session ID, statevector, circuit ops, histogram,
 * WebSocket connection) and distributes it to the four panels via props.
 *
 * Layout: 2×2 grid
 *   ┌─────────────┬─────────────┐
 *   │  Terminal   │ Bloch Sphere│
 *   ├─────────────┼─────────────┤
 *   │   Circuit   │  Histogram  │
 *   └─────────────┴─────────────┘
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import Terminal    from './components/Terminal'
import BlochSphere from './components/BlochSphere'
import CircuitPanel from './components/CircuitPanel'
import Histogram   from './components/Histogram'
import { newSession, getSnapshots } from './services/apiClient'
import { WSClient }                  from './services/wsClient'

export default function App() {
  // --- Session & connection -------------------------------------------------
  const [sessionId, setSessionId]   = useState(null)
  const [wsClient,  setWsClient]    = useState(null)
  const [wsStatus,  setWsStatus]    = useState('connecting')  // 'connecting' | 'ok' | 'error'

  // --- Quantum state shared between panels ----------------------------------
  const [statevector,  setStatevector]  = useState(null)      // [{re, im}, ...]
  const [numQubits,    setNumQubits]    = useState(0)
  const [circuitOps,   setCircuitOps]   = useState([])         // [{gate, qubits, step}, ...]
  const [histogram,    setHistogram]    = useState(null)       // {probabilities, hardware_probs?}
  const [shorFunction, setShorFunction] = useState(null)       // {x_values, y_values, label}
  const [noiseActive,  setNoiseActive]  = useState(false)
  const [noiseLevel,   setNoiseLevel]   = useState(0.01)

  // --- Lines to push to Terminal from WebSocket events ---------------------
  const [wsLines,   setWsLines]   = useState([])

  // --- Snapshot history for playback mode ----------------------------------
  const [snapshots, setSnapshots] = useState([])

  // ---- Bootstrap session on mount -----------------------------------------
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const sid = await newSession()
        if (!mounted) return
        setSessionId(sid)

        // Open WebSocket
        const ws = new WSClient(sid)
        setWsClient(ws)

        ws.on('__connected',    () => setWsStatus('ok'))
        ws.on('__disconnected', () => setWsStatus('error'))

        // Statevector push (after every gate)
        ws.on('statevector', data => {
          if (data.statevector) {
            setStatevector(data.statevector)
            setNumQubits(Math.round(Math.log2(data.statevector.length)))
          }
          if (data.circuit_ops) setCircuitOps(data.circuit_ops)
        })

        // Measurement histogram
        ws.on('histogram', data => {
          setHistogram(data)
          setShorFunction(null)      // clear Shor plot when a measurement comes in
        })

        // Shor's algorithm step
        ws.on('shor_step', data => {
          // Append lines to terminal
          const lines = [
            ``,
            `── Step ${data.step_number}: ${data.title}`,
            ...(data.detail || []).map(l => `   ${l}`),
          ]
          setWsLines(lines)

          // Periodic function histogram
          if (data.histogram) setShorFunction(data.histogram)
          // Circuit update
          if (data.circuit_ops) setCircuitOps(data.circuit_ops)
        })

        // Job status (hardware mode)
        ws.on('job_status', data => {
          if (data.lines) setWsLines(data.lines)
        })

        ws.on('job_complete', data => {
          if (data.lines) setWsLines(data.lines)
          if (data.counts) {
            setHistogram({
              probabilities:  normalise(data.ideal_counts || {}),
              hardware_probs: normalise(data.counts),
            })
          }
        })

        // Hamiltonian evolution steps
        ws.on('hamiltonian_step', data => {
          const lines = [`── Step ${data.step}: ${data.title}`,
                         ...(data.lines || []).map(l => `   ${l}`)]
          setWsLines(lines)
          // Push evolved statevector to Bloch sphere on final step
          if (data.statevector) {
            setStatevector(data.statevector)
            setNumQubits(Math.round(Math.log2(data.statevector.length)))
          }
        })

        // Generic output lines (e.g. "Algorithm complete")
        ws.on('output', data => {
          if (data.lines) setWsLines(data.lines)
        })

        // Error messages
        ws.on('error', data => {
          setWsLines([`[error] ${data.message}`])
        })

        ws.connect()
      } catch (err) {
        if (mounted) setWsStatus('error')
        console.error('Session bootstrap failed:', err)
      }
    })()

    return () => {
      mounted = false
      wsClient?.disconnect()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear wsLines after Terminal has consumed them (avoid replay on re-render)
  useEffect(() => {
    if (wsLines.length > 0) {
      const t = setTimeout(() => setWsLines([]), 50)
      return () => clearTimeout(t)
    }
  }, [wsLines])

  // ---- Handlers passed down to Terminal ------------------------------------

  const handleStatevector = useCallback((sv) => {
    setStatevector(sv)
    setNumQubits(Math.round(Math.log2(sv.length)))
    // Refresh snapshot list from backend so playback is always current
    if (sessionId) {
      getSnapshots(sessionId)
        .then(data => setSnapshots(data.snapshots || []))
        .catch(() => {})
    }
  }, [sessionId])

  const handleCircuitOps = useCallback((ops) => {
    setCircuitOps(ops)
  }, [])

  const handleHistogram = useCallback((h) => {
    setHistogram(h)
    setShorFunction(null)
  }, [])

  // Playback: restore a specific snapshot frame
  const handlePlaybackFrame = useCallback((frame) => {
    if (!frame) return
    if (frame.statevector) setStatevector(frame.statevector)
    if (frame.circuit_ops) setCircuitOps(frame.circuit_ops)
  }, [])

  // Detect noise commands from terminal output — called by Terminal after dispatch
  const handleNoiseState = useCallback((active, level) => {
    setNoiseActive(active)
    if (level !== undefined) setNoiseLevel(level)
  }, [])

  // ---- Render --------------------------------------------------------------
  return (
    <>
      {/* ── Top status bar ────────────────────────────────────────────────── */}
      <div className="status-bar">
        <span className="status-title">⬡ QUANTUM HACKER TERMINAL</span>
        <div className="status-items">
          <StatusPill
            label="QUBITS"
            value={numQubits || '—'}
            colour={numQubits ? '#00ff88' : '#444'}
          />
          <StatusPill
            label="GATES"
            value={circuitOps.length || '—'}
            colour={circuitOps.length ? '#00cc66' : '#444'}
          />
          <StatusPill
            label="NOISE"
            value={noiseActive ? `${(noiseLevel * 100).toFixed(1)}%` : 'OFF'}
            colour={noiseActive ? '#ffaa00' : '#444'}
          />
          <StatusPill
            label="WS"
            value={wsStatus.toUpperCase()}
            colour={wsStatus === 'ok' ? '#00ff88' : wsStatus === 'connecting' ? '#ffaa00' : '#ff4444'}
          />
        </div>
      </div>

      <div className="app-grid">
        <Terminal
          sessionId={sessionId}
          onStatevector={handleStatevector}
          onCircuitOps={handleCircuitOps}
          onHistogram={handleHistogram}
          onNoiseState={handleNoiseState}
          wsLines={wsLines}
          snapshots={snapshots}
          onPlaybackFrame={handlePlaybackFrame}
        />

        <BlochSphere
          statevector={statevector}
          noiseActive={noiseActive}
        />

        <CircuitPanel
          gateList={circuitOps}
          numQubits={numQubits}
        />

        <Histogram
          histogram={histogram}
          shorFunction={shorFunction}
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Status bar pill
// ---------------------------------------------------------------------------
function StatusPill({ label, value, colour: color }) {
  return (
    <div style={{
      display:    'flex',
      alignItems: 'center',
      gap:        4,
      padding:    '2px 8px',
      borderRadius: 3,
      background: '#0f0f0f',
      border:     `1px solid #1e1e1e`,
    }}>
      <span style={{ color: '#444', fontSize: 9 }}>{label}</span>
      <span style={{ color, fontSize: 10, fontWeight: 700 }}>{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert raw counts { "00": 512 } to probability dict { "00": 0.5 }. */
function normalise(counts) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0)
  if (total === 0) return counts
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]))
}
