"""
Noise model manager for the Quantum Hacker Terminal.

Uses Qiskit Aer's NoiseModel to attach depolarising and phase-flip errors
to all gate operations.  The error rate is configurable at runtime so the
user can see the effect of increasing noise on the Bloch sphere arrow
(the arrow shortens toward the origin as the state becomes more mixed).

Noise channels applied
-----------------------
Single-qubit gates:  depolarising(p) channel
Two-qubit gates:     depolarising(p * 10) channel   (2-qubit gates are noisier)
Measurement:         bit-flip  channel with prob p/2
                     phase-flip channel with prob p/2 (via readout_error)
"""

from __future__ import annotations

from typing import Optional

try:
    from qiskit_aer.noise import (
        NoiseModel,
        depolarizing_error,
        pauli_error,
        ReadoutError,
    )
    QISKIT_AVAILABLE = True
except ImportError:
    QISKIT_AVAILABLE = False

# Default error probability when noise is first switched on
_DEFAULT_RATE = 0.01

# All single-qubit gates that Aer recognises by their standard names
_SINGLE_QUBIT_GATES = ["h", "x", "y", "z", "s", "t", "sx", "sdg", "tdg", "u", "u1", "u2", "u3"]
_TWO_QUBIT_GATES    = ["cx", "cz", "swap"]


class NoiseManager:
    """Holds the current noise configuration for one session."""

    def __init__(self):
        self.active: bool     = False
        self.error_rate: float = _DEFAULT_RATE
        self._model: Optional[object] = None   # cached NoiseModel

    # ------------------------------------------------------------------
    # Control interface (called from routes.py)
    # ------------------------------------------------------------------

    def enable(self) -> None:
        self.active = True
        self._rebuild()

    def disable(self) -> None:
        self.active = False
        self._model = None

    def set_rate(self, rate: float) -> None:
        """Set error probability and rebuild the model if noise is active."""
        self.error_rate = max(0.0, min(1.0, rate))
        if self.active:
            self._rebuild()

    # ------------------------------------------------------------------
    # Model access
    # ------------------------------------------------------------------

    def get_model(self) -> Optional[object]:
        """Return the NoiseModel if active, else None."""
        return self._model if self.active else None

    # ------------------------------------------------------------------
    # Internal builder
    # ------------------------------------------------------------------

    def _rebuild(self) -> None:
        if not QISKIT_AVAILABLE:
            return

        p   = self.error_rate
        p2  = min(p * 10, 0.999)   # 2-qubit gates are typically ~10× noisier on real hardware

        model = NoiseModel()

        # Single-qubit depolarising error
        single_err = depolarizing_error(p, 1)
        for gate in _SINGLE_QUBIT_GATES:
            model.add_all_qubit_quantum_error(single_err, gate)

        # Two-qubit depolarising error
        two_err = depolarizing_error(p2, 2)
        for gate in _TWO_QUBIT_GATES:
            model.add_all_qubit_quantum_error(two_err, gate)

        # Readout error: bit-flip during measurement
        p_meas = min(p / 2, 0.5)
        ro_err = ReadoutError([[1 - p_meas, p_meas], [p_meas, 1 - p_meas]])
        model.add_all_qubit_readout_error(ro_err)

        self._model = model
