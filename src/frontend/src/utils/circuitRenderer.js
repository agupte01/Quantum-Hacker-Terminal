/**
 * circuitRenderer.js — Generates SVG layout data for the quantum circuit panel.
 *
 * Rather than manipulating the DOM directly, this module returns a plain data
 * structure (an array of render-objects) that CircuitPanel.jsx converts to
 * SVG elements.  This keeps the rendering logic pure and easily testable.
 *
 * Layout conventions
 * ------------------
 *  - Each gate occupies one horizontal "step" column (width = STEP_W px).
 *  - Each qubit occupies one horizontal wire row (height = ROW_H px).
 *  - Gate boxes are GATE_W × GATE_H px, centred on the qubit row.
 *  - CNOT is rendered as: filled dot on control, ⊕ on target, vertical line.
 *
 * The returned object is { width, height, wires, gates } where:
 *  - wires : [{ y, label }]
 *  - gates : [{ type, gate, x, y, y2? (for 2-qubit gates), label }]
 */

export const STEP_W  = 60    // horizontal distance between gate columns
export const ROW_H   = 48    // vertical distance between qubit rows
export const GATE_W  = 36    // gate box width
export const GATE_H  = 28    // gate box height
export const LEFT_PAD = 48   // space for qubit labels on the left

const TWO_QUBIT = new Set(['CNOT', 'CX', 'CZ', 'SWAP'])

/**
 * Compute SVG layout from a gate list.
 *
 * @param {Array<{gate, qubits, step}>} gateList   From circuit_manager.gate_list()
 * @param {number} numQubits
 * @returns {{ width, height, wires, gates }}
 */
export function buildLayout(gateList, numQubits) {
  if (numQubits === 0 || !gateList) {
    return { width: 200, height: ROW_H, wires: [], gates: [] }
  }

  const nSteps = gateList.length
  const width  = LEFT_PAD + nSteps * STEP_W + STEP_W   // +1 padding on right
  const height = numQubits * ROW_H + ROW_H / 2

  // Wire rows — one per qubit, y centred in each row
  const wires = Array.from({ length: numQubits }, (_, q) => ({
    y:     wireY(q),
    label: `q[${q}]`,
  }))

  // Gate render objects
  const gates = gateList.map((g, stepIdx) => {
    const gateName = g.gate.toUpperCase()
    const x = LEFT_PAD + stepIdx * STEP_W + STEP_W / 2

    if (TWO_QUBIT.has(gateName) && g.qubits.length >= 2) {
      const [c, t] = g.qubits
      return {
        type:  'two-qubit',
        gate:  gateName,
        x,
        y:     wireY(c),
        y2:    wireY(t),
        label: gateName === 'CNOT' || gateName === 'CX' ? 'CNOT' : gateName,
      }
    }

    return {
      type:  'single',
      gate:  gateName,
      x,
      y:     wireY(g.qubits[0] ?? 0),
      label: gateName,
    }
  })

  return { width, height, wires, gates }
}

function wireY(q) {
  return ROW_H / 2 + q * ROW_H
}
