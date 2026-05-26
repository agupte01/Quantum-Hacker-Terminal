"""
Hamiltonian simulation module for the Quantum Hacker Terminal.

Supports two commands exposed through the terminal DSL:

  run hamiltonian H=<expr> t=<float> [steps=<int>]
      Evolves the current statevector under e^{-iHt} using exact matrix
      exponentiation (eigendecomposition of H).

  run eigenvalues H=<expr>
      Diagonalises H classically and returns eigenvalues, eigenvectors, and
      the expectation value ⟨ψ|H|ψ⟩ in the current state.

Hamiltonian expression syntax
------------------------------
  H = weighted sum of Pauli tensor-product terms.

  Each term has the form:   [coeff*]P{q}[P{q}...]
  where:
    coeff  — optional float coefficient (default 1.0)
    P      — one of I X Y Z
    {q}    — qubit index (0-based)

  Terms are separated by + or -.

Examples
---------
  Z0                       →  σ_z on qubit 0
  0.5*X0+0.5*Z1            →  0.5 σ_x⊗I + 0.5 I⊗σ_z
  X0Z1                     →  σ_x⊗σ_z (tensor product on adjacent qubits)
  -1.0*Z0Z1+0.5*X0+0.5*X1  →  Ising model (J=-1, h=0.5)

Implementation
--------------
  We build the full 2^n × 2^n Hamiltonian matrix via Kronecker products and
  apply e^{-iHt}|ψ⟩ = V diag(e^{-iλt}) V† |ψ⟩  where H = VΛV† (Hermitian
  eigendecomposition, exact for small n).  No scipy required — numpy provides
  numpy.linalg.eigh for Hermitian matrices.
"""

from __future__ import annotations

import re
import math
from typing import List, Tuple, Dict, Any

import numpy as np

# ---------------------------------------------------------------------------
# Pauli matrices
# ---------------------------------------------------------------------------
_I = np.eye(2, dtype=complex)
_X = np.array([[0, 1], [1, 0]], dtype=complex)
_Y = np.array([[0, -1j], [1j, 0]], dtype=complex)
_Z = np.array([[1, 0], [0, -1]], dtype=complex)

_PAULI: Dict[str, np.ndarray] = {'I': _I, 'X': _X, 'Y': _Y, 'Z': _Z}


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
class PauliTerm:
    """
    One weighted Pauli tensor-product term.

    Example: 0.5 * (X on qubit 0) ⊗ (Z on qubit 2)
    represented as: coeff=0.5, ops={0: 'X', 2: 'Z'}
    """
    def __init__(self, coeff: float, ops: Dict[int, str]):
        self.coeff = coeff
        self.ops   = ops   # qubit → 'I'|'X'|'Y'|'Z'

    def matrix(self, n_qubits: int) -> np.ndarray:
        """Build the 2^n × 2^n matrix for this term."""
        # Start from qubit 0 (LSB in Qiskit convention) up to n-1
        result = np.array([[1.0 + 0j]], dtype=complex)
        for q in range(n_qubits):
            p = self.ops.get(q, 'I')
            result = np.kron(result, _PAULI[p])
        return self.coeff * result

    def __repr__(self):
        ops_str = ' ⊗ '.join(f"{p}[{q}]" for q, p in sorted(self.ops.items()) if p != 'I')
        return f"{self.coeff:+.4f} × {ops_str or 'I'}"


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
# Matches one Pauli term:  [±coeff*]  (P digit)+
#   Group 1: optional sign + coefficient
#   Group 2: the Pauli string e.g. "X0Z1" or "Z0Z1Z2"
_TERM_RE = re.compile(
    r'([+-]?\s*\d*\.?\d+\s*\*\s*)?([IXYZ]\d+(?:[IXYZ]\d+)*)',
    re.IGNORECASE,
)


def parse_hamiltonian(expr: str) -> List[PauliTerm]:
    """
    Parse a Hamiltonian expression string into a list of PauliTerm objects.
    Raises ValueError with a descriptive message on malformed input.
    """
    # Normalise: remove spaces around operators, make uppercase
    expr = expr.strip().upper().replace(' ', '')
    if not expr:
        raise ValueError("Empty Hamiltonian expression.")

    # Insert explicit '+' before leading minus so we can split cleanly
    # (the regex handles signs inside matches, but we need split boundaries)
    terms = []
    pos   = 0

    while pos < len(expr):
        # Skip leading +
        if expr[pos] == '+':
            pos += 1
            continue

        m = _TERM_RE.match(expr, pos)
        if not m:
            raise ValueError(
                f"Cannot parse Hamiltonian near position {pos}: '…{expr[pos:pos+12]}…'\n"
                f"Expected format: [coeff*]P{{q}}[P{{q}}…]  e.g. 0.5*X0+Z1"
            )

        # Extract coefficient
        coeff_str = (m.group(1) or '1').replace('*', '').replace(' ', '')
        try:
            coeff = float(coeff_str) if coeff_str not in ('', '+', '-') else \
                    (-1.0 if coeff_str == '-' else 1.0)
        except ValueError:
            raise ValueError(f"Invalid coefficient: '{coeff_str}'")

        # Extract Pauli ops from the operator string e.g. "X0Z2"
        pauli_str = m.group(2)
        ops = {}
        for pm in re.finditer(r'([IXYZ])(\d+)', pauli_str):
            gate, qubit = pm.group(1), int(pm.group(2))
            if gate in ops:
                raise ValueError(f"Duplicate Pauli on qubit {qubit} in term '{pauli_str}'")
            ops[qubit] = gate

        terms.append(PauliTerm(coeff, ops))
        pos = m.end()

    if not terms:
        raise ValueError(f"No valid Pauli terms found in: '{expr}'")
    return terms


# ---------------------------------------------------------------------------
# Hamiltonian matrix builder
# ---------------------------------------------------------------------------
def build_hamiltonian_matrix(terms: List[PauliTerm], n_qubits: int) -> np.ndarray:
    """Sum all term matrices into the full 2^n × 2^n Hamiltonian matrix."""
    dim = 2 ** n_qubits
    H   = np.zeros((dim, dim), dtype=complex)
    for term in terms:
        H += term.matrix(n_qubits)
    return H


# ---------------------------------------------------------------------------
# Time evolution
# ---------------------------------------------------------------------------
def evolve_statevector(psi: np.ndarray, H: np.ndarray, t: float) -> np.ndarray:
    """
    Compute |ψ(t)⟩ = e^{-iHt} |ψ⟩ using eigendecomposition.

    H must be Hermitian (numpy.linalg.eigh assumes this; it returns real
    eigenvalues and a unitary eigenvector matrix).

    For n ≤ 6 qubits (64×64 matrix) this is fast enough to be synchronous.
    For larger systems we fall back to a first-order Trotter approximation.
    """
    n = H.shape[0]

    if n <= 64:
        # Exact: diagonalise and apply phase factors
        eigvals, eigvecs = np.linalg.eigh(H)
        phases = np.exp(-1j * eigvals * t)
        evolved = eigvecs @ (phases * (eigvecs.conj().T @ psi))
    else:
        # First-order Trotter: e^{-iHt} ≈ (e^{-iHΔt})^k  for k steps
        k       = max(10, int(abs(t) * 20))
        dt      = t / k
        evolved = psi.copy()
        for _ in range(k):
            eigvals, eigvecs = np.linalg.eigh(H)
            phases  = np.exp(-1j * eigvals * dt)
            evolved = eigvecs @ (phases * (eigvecs.conj().T @ evolved))

    return evolved


# ---------------------------------------------------------------------------
# Eigenvalue analysis
# ---------------------------------------------------------------------------
def eigenvalue_analysis(
    H: np.ndarray,
    psi: np.ndarray,
    n_qubits: int,
) -> Dict[str, Any]:
    """
    Diagonalise H and compute:
      - Eigenvalues (energy levels)
      - Ground state energy and vector
      - Expectation value ⟨ψ|H|ψ⟩
      - Energy gap (first excited - ground)
    """
    eigvals, eigvecs = np.linalg.eigh(H)

    # Sort by eigenvalue (eigh already returns sorted, but be explicit)
    idx     = np.argsort(eigvals.real)
    eigvals = eigvals[idx]
    eigvecs = eigvecs[:, idx]

    expectation = float(np.real(psi.conj() @ H @ psi))
    gap         = float(eigvals[1].real - eigvals[0].real) if len(eigvals) > 1 else 0.0

    return {
        "eigenvalues":    [round(float(e.real), 6) for e in eigvals],
        "ground_energy":  round(float(eigvals[0].real), 6),
        "expectation":    round(expectation, 6),
        "energy_gap":     round(gap, 6),
        "n_levels":       len(eigvals),
    }


# ---------------------------------------------------------------------------
# Step-trace generator for streaming to the terminal
# ---------------------------------------------------------------------------
async def hamiltonian_steps(
    expr: str,
    psi: np.ndarray,
    n_qubits: int,
    t: float,
    n_steps: int = 8,
):
    """
    Async generator that yields one step-dict per phase of the simulation.
    Each dict is ready to be sent as a WebSocket 'hamiltonian_step' event.
    """
    import asyncio

    # Step 1 — Parse
    try:
        terms = parse_hamiltonian(expr)
    except ValueError as exc:
        yield {"step": 1, "title": "Parse error", "lines": [f"[error] {exc}"], "error": True}
        return

    yield {
        "step":  1,
        "title": "Hamiltonian parsed",
        "lines": [
            f"H = {' + '.join(str(t) for t in terms)}",
            f"  {len(terms)} Pauli term(s),  {n_qubits} qubits,  dim = {2**n_qubits}",
        ],
    }
    await asyncio.sleep(0.4)

    # Step 2 — Build matrix
    H = build_hamiltonian_matrix(terms, n_qubits)

    # Show a small excerpt of H for 1-2 qubits
    mat_lines = []
    if n_qubits <= 2:
        for row in H:
            mat_lines.append("  " + "  ".join(
                f"{v.real:+.3f}" + (f"{v.imag:+.3f}j" if abs(v.imag) > 1e-9 else "")
                for v in row
            ))

    yield {
        "step":  2,
        "title": "Hamiltonian matrix H (dim={})".format(2**n_qubits),
        "lines": mat_lines or ["  (matrix too large to display inline)"],
    }
    await asyncio.sleep(0.4)

    # Step 3 — Eigenvalues
    analysis = eigenvalue_analysis(H, psi, n_qubits)
    eigs = analysis["eigenvalues"]

    yield {
        "step":  3,
        "title": "Eigenvalue spectrum",
        "lines": [
            "  Energy levels: " + "  ".join(f"E{i}={e}" for i, e in enumerate(eigs[:8])),
            f"  Ground state energy  E₀ = {analysis['ground_energy']}",
            f"  Energy gap           ΔE = {analysis['energy_gap']}",
            f"  Current expectation  ⟨ψ|H|ψ⟩ = {analysis['expectation']}",
        ],
        "eigenvalues": analysis,
    }
    await asyncio.sleep(0.4)

    # Step 4 — Evolve
    evolved_states = []
    dt = t / n_steps
    current_psi = psi.copy()

    for k in range(1, n_steps + 1):
        current_psi = evolve_statevector(current_psi, H, dt)
        sv_serial   = [{"re": float(a.real), "im": float(a.imag)} for a in current_psi]
        evolved_states.append(sv_serial)

    yield {
        "step":    4,
        "title":   f"Time evolution e^{{-iHt}} for t={t}",
        "lines": [
            f"  Evolving |ψ⟩ under H for t = {t}  ({n_steps} intermediate steps)",
            f"  Algorithm: exact eigendecomposition (Hermitian diagonalisation)",
            f"  Final ⟨ψ(t)|H|ψ(t)⟩ = {round(float(np.real(current_psi.conj() @ H @ current_psi)), 6)}",
        ],
        "statevector": evolved_states[-1],   # final state for Bloch sphere
        "all_frames":  evolved_states,        # for playback
    }
    await asyncio.sleep(0.4)

    # Step 5 — Done
    yield {
        "step":  5,
        "title": "Evolution complete",
        "lines": [
            "  The Bloch sphere now shows the evolved state |ψ(t)⟩.",
            "  Use playback controls to replay the trajectory.",
        ],
    }
