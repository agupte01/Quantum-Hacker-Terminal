/**
 * blochMath.js — Pure-math utilities for Bloch sphere visualisation.
 *
 * The statevector from the backend is an array of {re, im} objects representing
 * the complex amplitudes of a 2^n dimensional quantum state.  This module
 * computes:
 *   1. The reduced density matrix for a chosen qubit (partial trace).
 *   2. The Bloch vector [x, y, z] via Pauli expectations.
 *   3. SLERP interpolation for smooth 3D animation between states.
 *
 * Convention (matching Qiskit's default):
 *   Qubit 0 is the RIGHTMOST bit of the computational basis label.
 *   |ψ⟩ = Σ_i  α_i |i⟩  where i is interpreted as an n-bit integer.
 */

// ---------------------------------------------------------------------------
// Complex number helpers
// ---------------------------------------------------------------------------

const mul = (a, b) => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})

const conj = (a) => ({ re: a.re, im: -a.im })

const add = (a, b) => ({ re: a.re + b.re, im: a.im + b.im })

// ---------------------------------------------------------------------------
// Partial trace → reduced density matrix
// ---------------------------------------------------------------------------

/**
 * Compute the 2×2 reduced density matrix for `qubitIndex` by tracing out
 * all other qubits from the pure state |ψ⟩.
 *
 * @param {Array<{re,im}>} sv    Statevector of length 2^n
 * @param {number} qubitIndex    0-based qubit to keep (Qiskit convention: 0 = LSB)
 * @returns {Array<Array<{re,im}>>}  2×2 density matrix [[ρ00,ρ01],[ρ10,ρ11]]
 */
export function reducedDensityMatrix(sv, qubitIndex) {
  const dim = sv.length
  const n   = Math.log2(dim)

  // Number of bits to the RIGHT of the target qubit (in the little-endian
  // Qiskit ordering where qubit 0 is the least-significant bit of the index).
  const lsb = qubitIndex          // bits below target qubit
  const stride = 1 << lsb        // distance between consecutive |0⟩/|1⟩ pairs

  let rho = [
    [{ re: 0, im: 0 }, { re: 0, im: 0 }],
    [{ re: 0, im: 0 }, { re: 0, im: 0 }],
  ]

  // Iterate over all basis states, pick out pairs that differ only on qubitIndex
  for (let i = 0; i < dim; i++) {
    // Is the qubitIndex-th bit of i set?
    const bit_i = (i >> qubitIndex) & 1

    for (let j = 0; j < dim; j++) {
      const bit_j = (j >> qubitIndex) & 1

      // Check that i and j agree on all bits EXCEPT qubitIndex
      const mask = ~(1 << qubitIndex) & (dim - 1)
      if ((i & mask) !== (j & mask)) continue

      // ρ[bit_i][bit_j] += ψ[i] * conj(ψ[j])
      const term = mul(sv[i], conj(sv[j]))
      rho[bit_i][bit_j] = add(rho[bit_i][bit_j], term)
    }
  }

  return rho
}

// ---------------------------------------------------------------------------
// Bloch coordinates
// ---------------------------------------------------------------------------

/**
 * Extract Bloch vector [x, y, z] from a 2×2 density matrix.
 *
 *   x = Tr(ρ σ_x) = ρ_01.re + ρ_10.re  = 2 Re(ρ_01)
 *   y = Tr(ρ σ_y) = Im(ρ_10) - Im(ρ_01) = 2 Im(ρ_10)  [with σ_y = [[0,-i],[i,0]]]
 *   z = Tr(ρ σ_z) = ρ_00.re - ρ_11.re
 *
 * For a pure state the vector lies on the unit sphere (|r|=1).
 * For a mixed state (noise) the vector shrinks toward the origin.
 */
export function blochVector(rho) {
  const x = 2 * rho[0][1].re
  const y = 2 * rho[1][0].im
  const z = rho[0][0].re - rho[1][1].re
  return [x, y, z]
}

/**
 * One-shot helper: statevector → Bloch vector for a chosen qubit.
 */
export function statevectorToBloch(sv, qubitIndex = 0) {
  if (!sv || sv.length === 0) return [0, 0, 1]

  const n = Math.log2(sv.length)
  const q = Math.max(0, Math.min(Math.round(n) - 1, qubitIndex))

  const rho = reducedDensityMatrix(sv, q)
  return blochVector(rho)
}

// ---------------------------------------------------------------------------
// SLERP (spherical linear interpolation)
// ---------------------------------------------------------------------------

/**
 * Interpolate between two Bloch vectors using SLERP.
 * Falls back to linear lerp when the vectors are nearly parallel (θ ≈ 0).
 *
 * @param {[number,number,number]} v0  Start vector
 * @param {[number,number,number]} v1  End vector
 * @param {number} t   Interpolation parameter in [0, 1]
 * @returns {[number,number,number]}
 */
export function slerp(v0, v1, t) {
  const dot = clamp(v0[0]*v1[0] + v0[1]*v1[1] + v0[2]*v1[2], -1, 1)
  const theta = Math.acos(dot)

  if (Math.abs(theta) < 1e-6) {
    // Vectors are nearly identical — plain linear interpolation
    return lerp3(v0, v1, t)
  }

  const sinTheta = Math.sin(theta)
  const s0 = Math.sin((1 - t) * theta) / sinTheta
  const s1 = Math.sin(t       * theta) / sinTheta

  return [
    s0 * v0[0] + s1 * v1[0],
    s0 * v0[1] + s1 * v1[1],
    s0 * v0[2] + s1 * v1[2],
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function lerp3(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

/** Euclidean magnitude of a 3-vector. */
export function magnitude(v) {
  return Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
}
