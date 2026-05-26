/**
 * Terminal.jsx — Command-line input/output panel.
 *
 * Features:
 *  - Command history navigable with ↑/↓ arrow keys.
 *  - Streaming output: each line appears token-by-token with a short delay,
 *    simulating a real teletype terminal.
 *  - Lines are coloured based on content prefix: [error] → red, [warn] → amber.
 *  - Playback controls (play/pause/step) for scrubbing through snapshot history.
 *  - Interactive demos: three curated examples with animated step-by-step execution.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { sendCommand } from '../services/apiClient'

const CHAR_DELAY_MS  = 12   // per-char streaming delay (output)
const TYPE_DELAY_MS  = 42   // per-char typing delay (demo input animation)
const SUBMIT_PAUSE   = 320  // pause between typing done and submit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Line colouring
// ---------------------------------------------------------------------------
function lineClass(text) {
  if (text.startsWith('[error]'))                               return 'error'
  if (text.startsWith('[warn]'))                                return 'warn'
  if (/^\[(?:shor|hardware|hamiltonian|eigenvalues)\]/.test(text)) return 'accent'
  if (/^[─┌├└│┐┘┤┬┴┼]/.test(text))                            return 'dim'
  if (text.startsWith('  ') || text.startsWith('── '))         return 'dim'
  if (text.startsWith('#'))                                     return 'demo-comment'
  return ''
}

// ---------------------------------------------------------------------------
// Syntax highlighter — returns [{text, cls}] spans
// ---------------------------------------------------------------------------
const KW_RE = /^(init|reset|apply|measure|run|noise|help|clear|sv|entropy|fidelity|depth|export)(\s|$)/i

function syntaxSpans(text) {
  const spans = []
  let rest = text

  const km = KW_RE.exec(rest)
  if (km) {
    spans.push({ text: km[1], cls: 'kw' })
    rest = rest.slice(km[1].length)
  }

  let last = 0
  const all = [...rest.matchAll(/\b(H|X|Y|Z|S|T|SX|SDG|TDG|RX|RY|RZ|CNOT|CX|CZ|SWAP)\b|(-?\d*\.?\d+)/gi)]
  for (const m of all) {
    if (m.index > last) spans.push({ text: rest.slice(last, m.index), cls: '' })
    spans.push({ text: m[0], cls: m[1] ? 'gate' : 'num' })
    last = m.index + m[0].length
  }
  if (last < rest.length) spans.push({ text: rest.slice(last), cls: '' })
  return spans
}

// ---------------------------------------------------------------------------
// Gate quick-bar buttons
// ---------------------------------------------------------------------------
const GATE_BUTTONS = [
  { label: 'H',       cmd: q => `apply H ${q}`,          cls: '' },
  { label: 'X',       cmd: q => `apply X ${q}`,          cls: '' },
  { label: 'Y',       cmd: q => `apply Y ${q}`,          cls: '' },
  { label: 'Z',       cmd: q => `apply Z ${q}`,          cls: '' },
  { label: 'S',       cmd: q => `apply S ${q}`,          cls: '' },
  { label: 'T',       cmd: q => `apply T ${q}`,          cls: '' },
  { label: 'RY(90)',  cmd: q => `apply RY(90) ${q}`,     cls: '' },
  { label: 'RZ(45)',  cmd: q => `apply RZ(45) ${q}`,     cls: '' },
  { label: 'CNOT',    cmd: q => `apply CNOT ${q} ${q+1}`, cls: 'two-q' },
  { label: 'CZ',      cmd: q => `apply CZ ${q} ${q+1}`,  cls: 'two-q' },
  { label: 'SWAP',    cmd: q => `apply SWAP ${q} ${q+1}`, cls: 'two-q' },
  { label: 'measure', cmd: ()  => 'measure',              cls: 'special' },
  { label: 'sv',      cmd: ()  => 'sv',                   cls: 'special' },
  { label: '|Bell⟩',  cmd: ()  => 'init bell',            cls: 'special' },
  { label: 'GHZ-3',   cmd: ()  => 'init ghz 3',           cls: 'special' },
  { label: 'QFT',     cmd: ()  => 'run qft',              cls: 'special' },
  { label: 'entropy', cmd: ()  => 'entropy',              cls: 'special' },
  { label: 'depth',   cmd: ()  => 'depth',                cls: 'special' },
]

// ---------------------------------------------------------------------------
// Interactive Demo Definitions
// Each step: { cmd, comment, pause }
//   cmd     — command to execute
//   comment — narrative shown before typing (green italic)
//   pause   — ms to wait AFTER the command returns (let visuals breathe)
// ---------------------------------------------------------------------------
const DEMOS = [
  {
    id:    'bell',
    title: 'Bell State',
    icon:  '⟨Φ+⟩',
    color: '#00ff88',
    tagline: 'Entangle two qubits — the heart of quantum computing',
    steps: [
      { cmd: 'init 2',
        comment: '# Step 1: Allocate a 2-qubit register in state |00⟩',
        pause: 900 },
      { cmd: 'apply H 0',
        comment: '# Step 2: Hadamard puts qubit 0 into superposition  (|0⟩+|1⟩)/√2',
        pause: 1300 },
      { cmd: 'apply CNOT 0 1',
        comment: '# Step 3: CNOT entangles the qubits → Bell pair |Φ+⟩',
        pause: 1400 },
      { cmd: 'sv',
        comment: '# Step 4: Inspect amplitudes — both |00⟩ and |11⟩ at 1/√2',
        pause: 1000 },
      { cmd: 'entropy',
        comment: '# Step 5: Von Neumann entropy = 1 bit → maximally entangled',
        pause: 1000 },
      { cmd: 'fidelity 00',
        comment: '# Step 6: 50% fidelity to |00⟩ — measuring gives 00 or 11',
        pause: 900 },
      { cmd: 'measure',
        comment: '# Step 7: Collapse — outcomes are perfectly correlated',
        pause: 700 },
    ],
  },
  {
    id:    'grover',
    title: "Grover Search",
    icon:  '◈',
    color: '#6688ff',
    tagline: 'Find |101⟩ in 3-qubit space with quantum amplitude amplification',
    steps: [
      { cmd: 'init 3',
        comment: '# Step 1: 3-qubit register — 8 possible states (|000⟩…|111⟩)',
        pause: 900 },
      { cmd: 'apply H 0',
        comment: '# Step 2a: Hadamard on qubit 0 — enter superposition',
        pause: 700 },
      { cmd: 'apply H 1',
        comment: '# Step 2b: Hadamard on qubit 1',
        pause: 700 },
      { cmd: 'apply H 2',
        comment: '# Step 2c: Hadamard on qubit 2 — all 8 states equally likely (12.5% each)',
        pause: 1100 },
      { cmd: 'sv',
        comment: '# Step 3: Uniform superposition confirmed — every amplitude = 1/√8',
        pause: 1100 },
      { cmd: 'run grover target=101',
        comment: '# Step 4: Grover oracle + diffuser — amplify |101⟩, suppress others',
        pause: 2200 },
      { cmd: 'sv',
        comment: '# Step 5: |101⟩ amplitude now dominates — quantum speedup visible!',
        pause: 1100 },
      { cmd: 'fidelity 101',
        comment: '# Step 6: Check overlap — should be close to 1.0',
        pause: 900 },
      { cmd: 'depth',
        comment: '# Step 7: Circuit depth — see the oracle + diffuser complexity',
        pause: 800 },
      { cmd: 'measure',
        comment: '# Step 8: Measure — |101⟩ should appear with high probability',
        pause: 700 },
    ],
  },
  {
    id:    'hamiltonian',
    title: 'Ising Evolution',
    icon:  '⚛',
    color: '#ffaa00',
    tagline: 'Evolve a Bell state under a quantum Ising Hamiltonian with noise',
    steps: [
      { cmd: 'init bell',
        comment: '# Step 1: Prepare |Φ+⟩ Bell pair — maximally entangled start',
        pause: 1100 },
      { cmd: 'entropy',
        comment: '# Step 2: Confirm S = 1 bit — maximum entanglement',
        pause: 1000 },
      { cmd: 'noise on',
        comment: '# Step 3: Enable quantum noise (p = 0.01 depolarising)',
        pause: 800 },
      { cmd: 'run hamiltonian H=-1.0*Z0Z1+0.5*X0 t=3.14159 steps=8',
        comment: '# Step 4: Evolve under Ising+transverse-field for t = π — streaming…',
        pause: 3500 },
      { cmd: 'noise off',
        comment: '# Step 5: Disable noise for a clean final measurement',
        pause: 700 },
      { cmd: 'entropy',
        comment: '# Step 6: Entropy after evolution — entanglement may have changed',
        pause: 1000 },
      { cmd: 'run eigenvalues H=-1.0*Z0Z1+0.5*X0',
        comment: '# Step 7: Diagonalise Hamiltonian — inspect ground state energy gap',
        pause: 1300 },
      { cmd: 'sv',
        comment: '# Step 8: Final statevector — see how Hamiltonian rotated the state',
        pause: 1000 },
      { cmd: 'measure',
        comment: '# Step 9: Measure the evolved state',
        pause: 700 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function Terminal({
  sessionId,
  onStatevector,
  onCircuitOps,
  onHistogram,
  onNoiseState,
  wsLines,
  snapshots,
  onPlaybackFrame,
}) {
  const [lines, setLines] = useState([
    { id: 0, text: '╔═══════════════════════════════════════════════╗', cls: 'dim' },
    { id: 1, text: '║       QUANTUM HACKER TERMINAL  v1.0           ║', cls: '' },
    { id: 2, text: '║  FastAPI · Qiskit · Three.js · React          ║', cls: 'dim' },
    { id: 3, text: '╚═══════════════════════════════════════════════╝', cls: 'dim' },
    { id: 4, text: "Type 'help' or click a demo below to begin.", cls: 'muted' },
    { id: 5, text: '', cls: '' },
  ])
  const [input,    setInput]    = useState('')
  const [history,  setHistory]  = useState([])
  const [histIdx,  setHistIdx]  = useState(-1)

  // Demo state
  const [demoRunning, setDemoRunning] = useState(false)  // which demo id is running, or null
  const [demoStep,    setDemoStep]    = useState(0)       // current step index
  const demoAbortRef = useRef(false)

  // Playback
  const [playbackIdx, setPlaybackIdx] = useState(0)
  const [isPlaying,   setIsPlaying]   = useState(false)
  const playIntervalRef = useRef(null)

  const lineIdRef  = useRef(100)
  const bodyRef    = useRef(null)
  const inputRef   = useRef(null)
  const [targetQubit, setTargetQubit] = useState(0)

  // Auto-scroll
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // WS lines
  useEffect(() => {
    if (!wsLines || wsLines.length === 0) return
    appendLines(wsLines)
  }, [wsLines]) // eslint-disable-line

  // Playback
  useEffect(() => {
    if (!isPlaying) { clearInterval(playIntervalRef.current); return }
    playIntervalRef.current = setInterval(() => {
      setPlaybackIdx(i => {
        const next = i + 1
        if (next >= snapshots.length) { setIsPlaying(false); return i }
        onPlaybackFrame(snapshots[next])
        return next
      })
    }, 700)
    return () => clearInterval(playIntervalRef.current)
  }, [isPlaying, snapshots, onPlaybackFrame])

  // ---- Line streaming -------------------------------------------------------
  const appendLines = useCallback((newLines) => {
    newLines.forEach((text, lineOffset) => {
      const id  = ++lineIdRef.current
      const cls = lineClass(text)
      let charIdx = 0

      const stream = () => {
        charIdx++
        setLines(prev => {
          const existing = prev.find(l => l.id === id)
          if (existing) return prev.map(l => l.id === id ? { ...l, text: text.slice(0, charIdx) } : l)
          return [...prev, { id, text: text.slice(0, charIdx), cls }]
        })
        if (charIdx < text.length) setTimeout(stream, CHAR_DELAY_MS)
      }
      setTimeout(stream, lineOffset * (text.length * CHAR_DELAY_MS * 0.3))
    })
  }, [])

  // ---- Multi-command splitter -----------------------------------------------
  const splitCommands = (raw) => {
    const parts = raw.split('&&').map(s => s.trim()).filter(Boolean)
    const boundary = /\s+(?=(?:init|reset|apply|measure|run|noise|help|clear|sv|entropy|fidelity|depth|export)\b)/gi
    return parts.flatMap(p => p.split(boundary).map(s => s.trim()).filter(Boolean))
  }

  // ---- Single-command executor ----------------------------------------------
  const execOne = useCallback(async (cmd) => {
    if (!cmd || !sessionId) return

    setLines(prev => [...prev,
      { id: ++lineIdRef.current, text: `> ${cmd}`, cls: 'accent' },
    ])

    if (cmd === 'clear') { setLines([]); return }

    try {
      const resp = await sendCommand(sessionId, cmd)
      if (resp.statevector) onStatevector?.(resp.statevector)
      if (resp.circuit_ops) onCircuitOps?.(resp.circuit_ops)
      if (resp.histogram)   onHistogram?.(resp.histogram)
      appendLines(resp.lines || [])

      const lc = cmd.toLowerCase()
      if (lc === 'noise on')  onNoiseState?.(true)
      if (lc === 'noise off') onNoiseState?.(false)
      const lvlM = lc.match(/^noise\s+level=([\d.]+)/)
      if (lvlM) onNoiseState?.(true, parseFloat(lvlM[1]))
    } catch (err) {
      appendLines([`[error] Network error: ${err.message}`])
    }
  }, [sessionId, appendLines, onStatevector, onCircuitOps, onHistogram, onNoiseState])

  // ---- Demo runner ----------------------------------------------------------
  const runDemo = useCallback(async (demo) => {
    if (demoRunning) return
    demoAbortRef.current = false
    setDemoRunning(demo.id)
    setDemoStep(0)

    // Clear terminal and show banner
    setLines([
      { id: ++lineIdRef.current, text: `╔${'═'.repeat(53)}╗`, cls: 'dim' },
      { id: ++lineIdRef.current, text: `║  DEMO: ${demo.title.padEnd(45)}║`, cls: '' },
      { id: ++lineIdRef.current, text: `║  ${demo.tagline.slice(0,51).padEnd(51)}║`, cls: 'dim' },
      { id: ++lineIdRef.current, text: `╚${'═'.repeat(53)}╝`, cls: 'dim' },
      { id: ++lineIdRef.current, text: '', cls: '' },
    ])

    for (let i = 0; i < demo.steps.length; i++) {
      if (demoAbortRef.current) break
      const step = demo.steps[i]
      setDemoStep(i)

      // Show narrative comment
      if (step.comment) {
        appendLines([step.comment])
        await sleep(500)
      }
      if (demoAbortRef.current) break

      // Animate typing the command
      for (let c = 1; c <= step.cmd.length; c++) {
        if (demoAbortRef.current) break
        setInput(step.cmd.slice(0, c))
        await sleep(TYPE_DELAY_MS)
      }
      if (demoAbortRef.current) break

      // Brief pause with full command visible
      await sleep(SUBMIT_PAUSE)
      if (demoAbortRef.current) break

      // Clear input and execute
      setInput('')
      await execOne(step.cmd)

      // Wait for visuals and streaming to settle
      await sleep(step.pause || 800)
    }

    if (!demoAbortRef.current) {
      await sleep(400)
      appendLines([
        '',
        '┌──────────────────────────────────────┐',
        `│  ✓  Demo "${demo.title}" complete.   │`,
        '│  Try modifying the circuit above!    │',
        '└──────────────────────────────────────┘',
        '',
      ])
    }

    setInput('')
    setDemoRunning(null)
    setDemoStep(0)
    inputRef.current?.focus()
  }, [demoRunning, execOne, appendLines])

  const stopDemo = useCallback(() => {
    demoAbortRef.current = true
    setDemoRunning(null)
    setDemoStep(0)
    setInput('')
    appendLines(['', '# Demo stopped.', ''])
  }, [appendLines])

  // ---- Command submission ---------------------------------------------------
  const submit = useCallback(async () => {
    if (demoRunning) return
    const raw = input.trim()
    if (!raw || !sessionId) return
    setInput('')
    setHistory(prev => [raw, ...prev.slice(0, 99)])
    setHistIdx(-1)
    for (const cmd of splitCommands(raw)) await execOne(cmd)
  }, [input, sessionId, execOne, demoRunning])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      submit()
    } else if (e.key === 'Escape' && demoRunning) {
      stopDemo()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistIdx(i => { const n = Math.min(i + 1, history.length - 1); setInput(history[n] ?? ''); return n })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistIdx(i => { const n = Math.max(i - 1, -1); setInput(n === -1 ? '' : (history[n] ?? '')); return n })
    }
  }

  const insertGate = useCallback((cmd) => {
    if (demoRunning) return
    setInput(cmd)
    inputRef.current?.focus()
  }, [demoRunning])

  const jumpToFrame = (idx) => {
    const i = Math.max(0, Math.min(snapshots.length - 1, idx))
    setPlaybackIdx(i)
    if (snapshots[i]) onPlaybackFrame(snapshots[i])
  }

  const spans = syntaxSpans(input)

  // ---- Render --------------------------------------------------------------
  return (
    <div className="panel" style={{ gridColumn: 1, gridRow: 1 }}>

      {/* ── Panel header ───────────────────────────────────────────────── */}
      <div className="panel-header">
        <span className="panel-title">TERMINAL</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#333', fontSize: 9 }}>target q:</span>
          <select
            value={targetQubit}
            onChange={e => setTargetQubit(Number(e.target.value))}
            disabled={!!demoRunning}
            style={{ background: '#0d0d0d', border: '1px solid #222', color: '#00ff88',
                     fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                     padding: '1px 3px', borderRadius: 2, cursor: 'pointer' }}>
            {[0,1,2,3,4,5,6,7].map(i => <option key={i} value={i}>q[{i}]</option>)}
          </select>
          <span style={{ color: '#333', fontSize: 10 }}>
            {sessionId ? sessionId.slice(0, 8) + '…' : 'no session'}
          </span>
        </div>
      </div>

      {/* ── Demo strip ─────────────────────────────────────────────────── */}
      <div className="demo-strip">
        <span className="demo-strip-label">DEMOS</span>
        <div className="demo-btns">
          {DEMOS.map(demo => {
            const isThis = demoRunning === demo.id
            const step   = demo.steps[demoStep]
            return (
              <button
                key={demo.id}
                className={`demo-btn ${isThis ? 'demo-btn--running' : ''}`}
                style={{ '--demo-color': demo.color }}
                onClick={() => isThis ? stopDemo() : runDemo(demo)}
                title={demo.tagline}
                disabled={!!demoRunning && !isThis}
              >
                <span className="demo-btn-icon">{demo.icon}</span>
                <span className="demo-btn-text">
                  {isThis
                    ? `${demoStep + 1}/${demo.steps.length} — ${step?.comment?.replace(/^#\s+Step \d+[a-z]*: /, '') ?? '…'}`
                    : demo.title}
                </span>
                {isThis && <span className="demo-btn-stop">✕ stop</span>}
                {isThis && (
                  <span className="demo-progress-bar">
                    <span
                      className="demo-progress-fill"
                      style={{ width: `${((demoStep + 1) / demo.steps.length) * 100}%`,
                               background: demo.color }}
                    />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Gate quick-buttons ─────────────────────────────────────────── */}
      <div className="gate-bar" style={{ opacity: demoRunning ? 0.4 : 1 }}>
        {GATE_BUTTONS.map(b => (
          <button
            key={b.label}
            className={`gate-btn ${b.cls}`}
            onClick={() => insertGate(b.cmd(targetQubit))}
            title={b.cmd(targetQubit)}
            disabled={!!demoRunning}
          >
            {b.label}
          </button>
        ))}
      </div>

      {/* ── Output lines ───────────────────────────────────────────────── */}
      <div className="terminal-body" ref={bodyRef}>
        {lines.map(l => (
          <div key={l.id} className={`terminal-line ${l.cls}`}>
            {l.text || '\u00A0'}
          </div>
        ))}
        <span className="cursor-blink" style={{ color: 'var(--text-primary)' }}>█</span>
      </div>

      {/* ── Command input ──────────────────────────────────────────────── */}
      <div className="terminal-input-row">
        <span className="terminal-prompt" style={{ color: demoRunning ? '#ffaa00' : 'var(--accent)' }}>
          {demoRunning ? '⏵' : 'λ'}
        </span>
        <div style={{ flex: 1, position: 'relative', height: 20 }}>
          {/* Syntax-highlight overlay */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 13,
            pointerEvents: 'none', whiteSpace: 'pre', overflow: 'hidden',
            lineHeight: '20px',
          }}>
            {spans.map((s, i) => (
              <span key={i} style={{ color:
                s.cls === 'kw'   ? (demoRunning ? '#ffcc44' : '#00ff88') :
                s.cls === 'gate' ? '#55ffbb' :
                s.cls === 'num'  ? '#ffcc44' : '#888'
              }}>{s.text}</span>
            ))}
          </div>
          <input
            ref={inputRef}
            className="terminal-input"
            value={input}
            onChange={e => { if (!demoRunning) setInput(e.target.value) }}
            onKeyDown={handleKeyDown}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            readOnly={!!demoRunning}
            placeholder={demoRunning ? 'demo running… (Esc to stop)' : 'enter command…'}
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              color:       'transparent',
              caretColor:  demoRunning ? '#ffaa00' : '#00ff88',
              background:  'transparent',
              cursor:      demoRunning ? 'default' : 'text',
            }}
          />
        </div>
        {demoRunning && (
          <button
            onClick={stopDemo}
            style={{ background: 'none', border: '1px solid #ff4444', color: '#ff4444',
                     fontFamily: 'inherit', fontSize: 10, padding: '1px 6px',
                     borderRadius: 2, cursor: 'pointer', flexShrink: 0 }}>
            stop
          </button>
        )}
      </div>

      {/* ── Playback controls ──────────────────────────────────────────── */}
      {snapshots.length > 0 && (
        <div className="playback-bar">
          <button className="playback-btn" onClick={() => jumpToFrame(0)}             title="Start">⏮</button>
          <button className="playback-btn" onClick={() => jumpToFrame(playbackIdx-1)} title="Step back">◀</button>
          <button
            className={`playback-btn ${isPlaying ? 'active' : ''}`}
            onClick={() => setIsPlaying(p => !p)}
            title={isPlaying ? 'Pause' : 'Play'}
          >{isPlaying ? '⏸' : '▶'}</button>
          <button className="playback-btn" onClick={() => jumpToFrame(playbackIdx+1)} title="Step fwd">▶</button>
          <button className="playback-btn" onClick={() => jumpToFrame(snapshots.length-1)} title="End">⏭</button>
          <input
            type="range"
            className="playback-slider"
            min={0} max={Math.max(0, snapshots.length-1)}
            value={playbackIdx}
            onChange={e => jumpToFrame(Number(e.target.value))}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 10, whiteSpace: 'nowrap' }}>
            {playbackIdx+1} / {snapshots.length}
          </span>
        </div>
      )}
    </div>
  )
}
