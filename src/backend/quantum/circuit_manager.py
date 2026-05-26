"""
CircuitManager — accumulates quantum gates for a single session and captures
statevector snapshots after every operation.

Design notes
------------
* We keep a *pristine* QuantumCircuit (no measurements, no save_statevector
  instructions) called `_base_circuit`.  When we need a statevector we append
  save_statevector() to a *copy*, compile, and simulate — this lets us keep
  adding gates without contaminating the base circuit with simulation artefacts.

* The AerSimulator is run in `statevector` method so every amplitude is exact
  (no shot noise).

* Gate metadata is stored in `_gate_list` (plain dicts) so the REST layer can
  serialise it straight to JSON for the SVG circuit renderer.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    from qiskit import QuantumCircuit, transpile
    from qiskit_aer import AerSimulator
    from qiskit_aer.noise import NoiseModel
    QISKIT_AVAILABLE = True
except ImportError:
    QISKIT_AVAILABLE = False


# Gate names → Qiskit QuantumCircuit method names
_GATE_MAP: Dict[str, str] = {
    "H":   "h",
    "X":   "x",
    "Y":   "y",
    "Z":   "z",
    "S":   "s",
    "T":   "t",
    "SX":  "sx",
    "SDG": "sdg",
    "TDG": "tdg",
    "CNOT": "cx",
    "CX":   "cx",
    "CZ":   "cz",
    "SWAP": "swap",
    # Rotation gates — these require an angle parameter and are handled specially
    "RX":  "rx",
    "RY":  "ry",
    "RZ":  "rz",
}

_TWO_QUBIT_GATES = {"CNOT", "CX", "CZ", "SWAP"}
_ROTATION_GATES  = {"RX", "RY", "RZ"}


class CircuitManager:
    """Manages the quantum circuit state for one browser session."""

    def __init__(self):
        self._num_qubits: int = 0
        self._base_circuit: Optional[Any] = None   # QuantumCircuit
        self._gate_list: List[Dict[str, Any]] = []
        self._simulator = AerSimulator(method="statevector") if QISKIT_AVAILABLE else None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    @property
    def num_qubits(self) -> int:
        return self._num_qubits

    def init(self, n: int) -> None:
        """Initialise (or re-initialise) an n-qubit register to |0…0⟩."""
        if not QISKIT_AVAILABLE:
            raise RuntimeError("Qiskit is not installed.")
        self._num_qubits = n
        self._base_circuit = QuantumCircuit(n)
        self._gate_list = []

    def apply_gate(self, gate: str, qubits: List[int], theta: Optional[float] = None) -> None:
        """
        Append a gate to the circuit.

        For rotation gates (RX/RY/RZ) the `theta` parameter (in radians) is
        required.  All other gates ignore it.
        """
        if self._base_circuit is None:
            raise ValueError("Circuit not initialised — run 'init <n>' first.")

        gate_upper = gate.upper()
        if gate_upper not in _GATE_MAP:
            raise ValueError(f"Unknown gate '{gate}'. Supported: {sorted(_GATE_MAP)}")

        # Bounds check
        for q in qubits:
            if q >= self._num_qubits:
                raise ValueError(
                    f"Qubit index {q} out of range for {self._num_qubits}-qubit circuit."
                )

        # Apply to base circuit
        method_name = _GATE_MAP[gate_upper]
        gate_method = getattr(self._base_circuit, method_name)

        if gate_upper in _ROTATION_GATES:
            if theta is None:
                raise ValueError(f"{gate_upper} requires an angle (in radians).")
            gate_method(theta, *qubits)
        else:
            gate_method(*qubits)

        # Record for the SVG renderer — include angle label for rotation gates
        label = gate_upper
        if gate_upper in _ROTATION_GATES and theta is not None:
            import math
            deg = round(math.degrees(theta), 1)
            label = f"{gate_upper}({deg}°)"

        self._gate_list.append({
            "gate":    label,
            "qubits":  qubits,
            "step":    len(self._gate_list),
        })

    def statevector(self, noise_model=None) -> np.ndarray:
        """
        Simulate the current circuit and return the complex statevector.

        If a noise model is provided, the simulation uses that noise channel,
        which causes the statevector to represent a mixed state (the returned
        vector is the *density matrix diagonal* in that case — the Bloch sphere
        renderer handles both).
        """
        if self._base_circuit is None:
            raise RuntimeError("Circuit not initialised.")

        qc = copy.deepcopy(self._base_circuit)
        qc.save_statevector()

        compiled = transpile(qc, self._simulator)
        result   = self._simulator.run(compiled, noise_model=noise_model).result()
        sv       = result.get_statevector(qc)
        return np.array(sv)

    def measure(self, shots: int = 1024, noise_model=None) -> Tuple[Dict[str, int], Dict[str, float]]:
        """
        Add measurements, run the circuit for `shots` samples, and return
        (raw_counts, probability_dict) both keyed by bitstring outcome.
        """
        if self._base_circuit is None:
            raise RuntimeError("Circuit not initialised.")

        qc = copy.deepcopy(self._base_circuit)
        qc.measure_all()

        sim = AerSimulator()
        if noise_model:
            compiled = transpile(qc, sim)
            result   = sim.run(compiled, shots=shots, noise_model=noise_model).result()
        else:
            compiled = transpile(qc, sim)
            result   = sim.run(compiled, shots=shots).result()

        counts = dict(result.get_counts(qc))
        probs  = {k: v / shots for k, v in counts.items()}
        return counts, probs

    def gate_list(self) -> List[Dict[str, Any]]:
        """Return serialisable gate list for the SVG circuit panel."""
        return list(self._gate_list)

    def depth(self) -> int:
        """Return circuit depth (number of gate layers)."""
        if self._base_circuit is None:
            return 0
        return self._base_circuit.depth()

    # ------------------------------------------------------------------
    # State preparation shortcuts
    # ------------------------------------------------------------------

    def init_bell(self) -> None:
        """Prepare the |Φ+⟩ Bell state on 2 qubits: H on q0, CNOT(0,1)."""
        if not QISKIT_AVAILABLE:
            raise RuntimeError("Qiskit is not installed.")
        self._num_qubits = 2
        self._base_circuit = QuantumCircuit(2)
        self._gate_list = []
        self._base_circuit.h(0)
        self._gate_list.append({"gate": "H", "qubits": [0], "step": 0})
        self._base_circuit.cx(0, 1)
        self._gate_list.append({"gate": "CNOT", "qubits": [0, 1], "step": 1})

    def init_ghz(self, n: int) -> None:
        """Prepare an n-qubit GHZ state: H on q0, then cascade of CNOTs."""
        if not QISKIT_AVAILABLE:
            raise RuntimeError("Qiskit is not installed.")
        if not (2 <= n <= 10):
            raise ValueError("GHZ state requires 2–10 qubits.")
        self._num_qubits = n
        self._base_circuit = QuantumCircuit(n)
        self._gate_list = []
        self._base_circuit.h(0)
        self._gate_list.append({"gate": "H", "qubits": [0], "step": 0})
        for i in range(n - 1):
            self._base_circuit.cx(i, i + 1)
            self._gate_list.append({"gate": "CNOT", "qubits": [i, i + 1], "step": i + 1})

    # ------------------------------------------------------------------
    # Quantum Fourier Transform
    # ------------------------------------------------------------------

    def apply_qft(self, n: Optional[int] = None) -> None:
        """Append QFT circuit over the first n qubits (default: all)."""
        import math
        if self._base_circuit is None:
            raise RuntimeError("Circuit not initialised.")
        n = n or self._num_qubits
        if n > self._num_qubits:
            raise ValueError(f"QFT over {n} qubits but circuit only has {self._num_qubits}.")

        step = len(self._gate_list)
        for j in range(n - 1, -1, -1):
            self._base_circuit.h(j)
            self._gate_list.append({"gate": "H", "qubits": [j], "step": step}); step += 1
            for k in range(j - 1, -1, -1):
                angle = math.pi / (2 ** (j - k))
                self._base_circuit.cp(angle, k, j)
                label = f"CP({round(math.degrees(angle), 1)}°)"
                self._gate_list.append({"gate": label, "qubits": [k, j], "step": step}); step += 1

        # Bit reversal via SWAP
        for i in range(n // 2):
            self._base_circuit.swap(i, n - 1 - i)
            self._gate_list.append({"gate": "SWAP", "qubits": [i, n - 1 - i], "step": step}); step += 1

    # ------------------------------------------------------------------
    # Grover's Algorithm
    # ------------------------------------------------------------------

    def apply_grover(self, target_bitstr: str) -> None:
        """
        Apply one full Grover iteration (oracle + diffuser) for the
        given target bitstring (little-endian, qubit 0 = rightmost).
        Requires the circuit to already be in uniform superposition.
        """
        if self._base_circuit is None:
            raise RuntimeError("Circuit not initialised.")
        n = self._num_qubits
        if len(target_bitstr) != n:
            raise ValueError(f"Target must be {n} bits, got '{target_bitstr}'.")
        if not all(c in "01" for c in target_bitstr):
            raise ValueError("Target must contain only '0' and '1'.")

        step = len(self._gate_list)

        # --- Phase oracle: flip phase of |target⟩ ----------------------
        # Flip qubits that should be |0⟩ in the target (so target → |11..1⟩)
        flip_qubits = [i for i, b in enumerate(target_bitstr) if b == "0"]
        for q in flip_qubits:
            self._base_circuit.x(q)
        # Multi-controlled Z via H + MCX + H on last qubit
        self._base_circuit.h(n - 1)
        if n > 1:
            self._base_circuit.mcx(list(range(n - 1)), n - 1)
        else:
            self._base_circuit.z(0)
        self._base_circuit.h(n - 1)
        for q in flip_qubits:
            self._base_circuit.x(q)
        self._gate_list.append({"gate": f"Oracle|{target_bitstr}⟩", "qubits": list(range(n)), "step": step}); step += 1

        # --- Grover diffuser (2|ψ⟩⟨ψ| − I) ----------------------------
        for q in range(n):
            self._base_circuit.h(q)
            self._base_circuit.x(q)
        self._base_circuit.h(n - 1)
        if n > 1:
            self._base_circuit.mcx(list(range(n - 1)), n - 1)
        else:
            self._base_circuit.z(0)
        self._base_circuit.h(n - 1)
        for q in range(n):
            self._base_circuit.x(q)
            self._base_circuit.h(q)
        self._gate_list.append({"gate": "Diffuser", "qubits": list(range(n)), "step": step})

    # ------------------------------------------------------------------
    # QASM export
    # ------------------------------------------------------------------

    def to_qasm(self) -> str:
        """Export current circuit to OpenQASM 2 string."""
        if self._base_circuit is None:
            raise RuntimeError("Circuit not initialised.")
        try:
            from qiskit.qasm2 import dumps
            return dumps(self._base_circuit)
        except Exception:
            return self._base_circuit.qasm()
