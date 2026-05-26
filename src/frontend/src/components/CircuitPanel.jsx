/**
 * CircuitPanel.jsx — SVG-based quantum circuit diagram.
 *
 * Renders qubit wire lines and gate boxes in real time as the user applies
 * gates.  The circuit scrolls horizontally when it grows wider than the panel.
 *
 * Single-qubit gates appear as labelled rectangles.
 * CNOT is rendered with the standard notation:
 *   • filled circle on the control qubit
 *   • ⊕ (direct sum) symbol on the target qubit
 *   • vertical connecting line between them
 * CZ and SWAP use bullet + bullet and ✕ × ✕ respectively.
 */

import React, { useMemo } from 'react'
import { buildLayout, STEP_W, ROW_H, GATE_W, GATE_H, LEFT_PAD } from '../utils/circuitRenderer'

// ---------------------------------------------------------------------------
// Colours (CSS vars are not interpolable inside SVG attributes on all browsers,
// so we inline the hex values here)
// ---------------------------------------------------------------------------
const C = {
  wire:    '#2a2a2a',
  gate:    '#001a0d',
  gateBdr: '#00ff88',
  gateText:'#00ff88',
  ctrl:    '#00ff88',
  target:  '#00ff88',
  cnot:    '#00ff88',
  muted:   '#555',
  bg:      '#111111',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CircuitPanel({ gateList, numQubits }) {
  const layout = useMemo(
    () => buildLayout(gateList || [], numQubits || 0),
    [gateList, numQubits],
  )

  if (!numQubits) {
    return (
      <div className="panel" style={{ gridColumn: 1, gridRow: 2 }}>
        <div className="panel-header">
          <span className="panel-title">CIRCUIT</span>
        </div>
        <div className="circuit-body" style={{ color: '#555', fontSize: 12, padding: 16 }}>
          Run <span style={{ color: '#00ff88' }}>init &lt;n&gt;</span> to create a circuit.
        </div>
      </div>
    )
  }

  const { width, height, wires, gates } = layout
  const svgH = Math.max(height, ROW_H)

  return (
    <div className="panel" style={{ gridColumn: 1, gridRow: 2 }}>
      <div className="panel-header">
        <span className="panel-title">CIRCUIT</span>
        <span style={{ color: C.muted, fontSize: 10 }}>
          {numQubits} qubits · {(gateList || []).length} gates
        </span>
      </div>

      <div className="circuit-body">
        <svg
          className="circuit-svg"
          width={width}
          height={svgH}
          style={{ display: 'block', minWidth: width }}
        >
          {/* Qubit wire lines */}
          {wires.map((w, i) => (
            <g key={i}>
              {/* Label */}
              <text
                x={LEFT_PAD - 6}
                y={w.y + 4}
                textAnchor="end"
                fill={C.gateText}
                fontSize={11}
                fontFamily="JetBrains Mono, monospace"
              >
                {w.label}
              </text>
              {/* Wire */}
              <line
                className="wire"
                x1={LEFT_PAD - 4}
                y1={w.y}
                x2={width - 4}
                y2={w.y}
                stroke={C.wire}
                strokeWidth={1}
              />
            </g>
          ))}

          {/* Gates */}
          {gates.map((g, i) => (
            <GateSymbol key={i} gate={g} />
          ))}

          {/* "end cap" double line */}
          <line x1={width - 8} y1={8} x2={width - 8} y2={svgH - 8}
                stroke={C.muted} strokeWidth={1} />
          <line x1={width - 5} y1={8} x2={width - 5} y2={svgH - 8}
                stroke={C.muted} strokeWidth={1} />
        </svg>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gate symbols
// ---------------------------------------------------------------------------

function GateSymbol({ gate: g }) {
  if (g.type === 'two-qubit') return <TwoQubitGate gate={g} />
  return <SingleGate gate={g} />
}

function SingleGate({ gate: g }) {
  const x  = g.x - GATE_W / 2
  const y  = g.y - GATE_H / 2

  // Special styling for H gate (light fill)
  const fill = g.gate === 'H' ? '#001f0d' : C.gate

  return (
    <g>
      <rect
        x={x} y={y}
        width={GATE_W} height={GATE_H}
        rx={3}
        fill={fill}
        stroke={C.gateBdr}
        strokeWidth={1}
      />
      <text
        x={g.x} y={g.y + 4}
        textAnchor="middle"
        fill={C.gateText}
        fontSize={11}
        fontFamily="JetBrains Mono, monospace"
        fontWeight="bold"
      >
        {g.label}
      </text>
    </g>
  )
}

function TwoQubitGate({ gate: g }) {
  const isSwap   = g.gate === 'SWAP'
  const isCZ     = g.gate === 'CZ'
  const isCNOT   = g.gate === 'CNOT' || g.gate === 'CX'
  const ctrlY    = g.y
  const targY    = g.y2

  return (
    <g>
      {/* Vertical connecting line */}
      <line
        x1={g.x} y1={ctrlY}
        x2={g.x} y2={targY}
        stroke={C.cnot}
        strokeWidth={1}
      />

      {/* Control qubit */}
      {isSwap
        ? <CrossX cx={g.x} cy={ctrlY} />
        : <circle cx={g.x} cy={ctrlY} r={5} fill={C.ctrl} />
      }

      {/* Target qubit */}
      {isCNOT && <PlusCircle cx={g.x} cy={targY} />}
      {isCZ   && <circle cx={g.x} cy={targY} r={5} fill={C.ctrl} />}
      {isSwap && <CrossX  cx={g.x} cy={targY} />}
    </g>
  )
}

// ⊕ symbol for CNOT target
function PlusCircle({ cx, cy }) {
  const r = 12
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={C.gate} stroke={C.cnot} strokeWidth={1} />
      <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke={C.cnot} strokeWidth={1} />
      <line x1={cx} y1={cy - r} x2={cx} y2={cy + r} stroke={C.cnot} strokeWidth={1} />
    </g>
  )
}

// ✕ symbol for SWAP
function CrossX({ cx, cy }) {
  const d = 8
  return (
    <g>
      <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d} stroke={C.ctrl} strokeWidth={2} />
      <line x1={cx + d} y1={cy - d} x2={cx - d} y2={cy + d} stroke={C.ctrl} strokeWidth={2} />
    </g>
  )
}
