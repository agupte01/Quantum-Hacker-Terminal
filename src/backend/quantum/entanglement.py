"""
Entanglement & information-theoretic utilities for the Quantum Hacker Terminal.

Functions
---------
von_neumann_entropy(sv, qubit_idx, n_qubits)
    Compute the von Neumann entropy S(ρ_A) of the subsystem containing
    `qubit_idx` by tracing out all other qubits.

fidelity(sv, target_bitstr)
    Return |⟨target|ψ⟩|² — probability of finding the state in the target
    computational-basis state.

concurrence(sv)
    For a 2-qubit pure state, compute the concurrence C ∈ [0, 1] which
    is a direct measure of entanglement.
"""

from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------------------
# Von Neumann entropy
# ---------------------------------------------------------------------------

def von_neumann_entropy(sv: np.ndarray, qubit_idx: int, n_qubits: int) -> float:
    """
    Compute S(ρ_A) = -Tr(ρ_A log₂ ρ_A) for the single-qubit subsystem A
    at position `qubit_idx`.

    Algorithm
    ---------
    1. Reshape |ψ⟩ into a (2^A, 2^B) matrix where A = {qubit_idx} and
       B = all other qubits.
    2. Compute the singular values σᵢ (Schmidt coefficients λᵢ = σᵢ²).
    3. S = -Σ λᵢ log₂ λᵢ  (skipping λ = 0 to avoid log(0)).

    Returns
    -------
    float
        Entropy in bits (log base 2).  0 = separable, 1 = maximally entangled.
    """
    dim = 2 ** n_qubits
    if len(sv) != dim:
        raise ValueError(f"State vector length {len(sv)} != 2^{n_qubits} = {dim}")

    # Move the target qubit to the first axis, reshape to (2, rest)
    # Qiskit uses little-endian ordering (qubit 0 = least-significant bit)
    psi = sv.reshape([2] * n_qubits)
    # Move qubit_idx to front, then reshape into bipartition (2, 2^(n-1))
    psi = np.moveaxis(psi, qubit_idx, 0).reshape(2, -1)

    # Schmidt decomposition via SVD
    _, s, _ = np.linalg.svd(psi, full_matrices=False)
    lambdas = s ** 2

    # Von Neumann entropy
    lambdas = lambdas[lambdas > 1e-15]   # drop numerical zeros
    entropy = float(-np.sum(lambdas * np.log2(lambdas)))
    return max(0.0, entropy)


def entropy_all_qubits(sv: np.ndarray, n_qubits: int) -> list[dict]:
    """Return entropy for each individual qubit subsystem."""
    return [
        {"qubit": i, "entropy": round(von_neumann_entropy(sv, i, n_qubits), 6)}
        for i in range(n_qubits)
    ]


# ---------------------------------------------------------------------------
# Fidelity
# ---------------------------------------------------------------------------

def fidelity(sv: np.ndarray, target_bitstr: str) -> float:
    """
    Return |⟨target|ψ⟩|² where |target⟩ is a computational-basis state.

    Parameters
    ----------
    sv : np.ndarray
        Complex statevector of length 2^n.
    target_bitstr : str
        Binary string e.g. "01" or "110".  Length must match n_qubits.
        Qiskit uses little-endian (rightmost bit = qubit 0).

    Returns
    -------
    float in [0, 1]
    """
    n = int(np.round(np.log2(len(sv))))
    if len(target_bitstr) != n:
        raise ValueError(
            f"Target bitstring length {len(target_bitstr)} doesn't match "
            f"{n} qubits.  Example: {'0' * n}"
        )
    if not all(c in "01" for c in target_bitstr):
        raise ValueError("Target bitstring must contain only '0' and '1'.")

    # Convert bitstring to integer index (little-endian: qubit 0 = rightmost)
    idx = int(target_bitstr[::-1], 2)   # reverse for Qiskit ordering
    amplitude = sv[idx]
    return float(abs(amplitude) ** 2)


# ---------------------------------------------------------------------------
# Concurrence (2-qubit states only)
# ---------------------------------------------------------------------------

def concurrence(sv: np.ndarray) -> float:
    """
    Compute the concurrence of a 2-qubit pure state.

    C = |⟨ψ|σ_y⊗σ_y|ψ*⟩| ∈ [0, 1]
    C = 0  → separable
    C = 1  → maximally entangled (Bell state)
    """
    if len(sv) != 4:
        raise ValueError("Concurrence is only defined for 2-qubit states.")

    sy = np.array([[0, -1j], [1j, 0]], dtype=complex)
    sysy = np.kron(sy, sy)
    psi_tilde = sysy @ np.conj(sv)
    c = abs(sv @ psi_tilde)
    return float(min(1.0, max(0.0, c)))


def entanglement_report(sv: np.ndarray, n_qubits: int) -> dict:
    """
    Return a full entanglement analysis dict:
      - per-qubit von Neumann entropy
      - concurrence (2-qubit only)
      - total entanglement (average entropy)
    """
    per_qubit = entropy_all_qubits(sv, n_qubits)
    avg_ent   = sum(d["entropy"] for d in per_qubit) / max(n_qubits, 1)

    result = {
        "per_qubit_entropy": per_qubit,
        "average_entropy":   round(avg_ent, 6),
    }
    if n_qubits == 2:
        result["concurrence"] = round(concurrence(sv), 6)

    return result
