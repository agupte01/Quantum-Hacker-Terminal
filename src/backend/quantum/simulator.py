"""
Thin wrapper around AerSimulator for one-off simulation tasks.

CircuitManager handles the per-session statevector simulation.  This module
provides utility functions used by the Shor module and the hardware module
when they need a quick ideal-sim result outside of a managed session.
"""

from __future__ import annotations

from typing import Dict, Tuple

try:
    from qiskit import QuantumCircuit, transpile
    from qiskit_aer import AerSimulator
    QISKIT_AVAILABLE = True
except ImportError:
    QISKIT_AVAILABLE = False


def run_ideal(qc, shots: int = 1024) -> Tuple[Dict[str, int], Dict[str, float]]:
    """
    Simulate a QuantumCircuit with no noise and return (counts, probabilities).
    The circuit must already include measurement gates.
    """
    if not QISKIT_AVAILABLE:
        raise RuntimeError("Qiskit / Qiskit-Aer is not installed.")

    sim      = AerSimulator()
    compiled = transpile(qc, sim)
    result   = sim.run(compiled, shots=shots).result()
    counts   = dict(result.get_counts(qc))
    probs    = {k: v / shots for k, v in counts.items()}
    return counts, probs


def statevector_of(qc) -> list:
    """
    Return the statevector of a circuit (no measurements).
    Result is a list of {"re": float, "im": float} dicts for JSON serialisation.
    """
    if not QISKIT_AVAILABLE:
        raise RuntimeError("Qiskit / Qiskit-Aer is not installed.")

    import copy
    qc2 = copy.deepcopy(qc)
    qc2.save_statevector()
    sim      = AerSimulator(method="statevector")
    compiled = transpile(qc2, sim)
    result   = sim.run(compiled).result()
    sv       = result.get_statevector(qc2)

    return [{"re": float(c.real), "im": float(c.imag)} for c in sv]
