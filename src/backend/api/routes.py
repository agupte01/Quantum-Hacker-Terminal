"""
REST API routes for the Quantum Hacker Terminal.

Every meaningful user action arrives here via POST /command.  The command
string is tokenised by the parser, dispatched to the appropriate quantum
module, and the result is returned synchronously.  Asynchronous events (job
status updates, step-by-step traces) are pushed over the WebSocket connection
that the frontend maintains in parallel.

Session state is kept in a simple in-process dict.  For a production
deployment you would swap this for Redis or a database.
"""

import asyncio
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.ws import manager as ws_manager
from parser.command_parser import CommandParser, ParsedCommand
from quantum.circuit_manager import CircuitManager
from quantum.noise import NoiseManager
from quantum.hardware import HardwareManager
from quantum.shor import ShorAlgorithm
from quantum.hamiltonian import (
    parse_hamiltonian, build_hamiltonian_matrix,
    eigenvalue_analysis, evolve_statevector, hamiltonian_steps,
)
from quantum.entanglement import entanglement_report, fidelity as calc_fidelity

router = APIRouter()

# ---------------------------------------------------------------------------
# In-process session store
# Each entry holds the live objects for one browser tab / session UUID.
# ---------------------------------------------------------------------------
_sessions: Dict[str, Dict[str, Any]] = {}


def _get_session(session_id: str) -> Dict[str, Any]:
    """Return the session dict, creating it if this is the first request."""
    if session_id not in _sessions:
        _sessions[session_id] = {
            "circuit_manager": CircuitManager(),
            "noise_manager":   NoiseManager(),
            "hardware_manager": HardwareManager(),
            "parser":          CommandParser(),
            "snapshots":       [],   # ordered list of statevector snapshots for playback
        }
    return _sessions[session_id]


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------
class CommandRequest(BaseModel):
    session_id: str
    command: str

class SessionResponse(BaseModel):
    session_id: str

class CommandResponse(BaseModel):
    success: bool
    lines: list[str]          # terminal output lines to display token-by-token
    statevector: Optional[list] = None   # [{"re": float, "im": float}, ...]
    circuit_ops: Optional[list] = None   # list of gate dicts for the SVG renderer
    histogram: Optional[dict] = None     # {"counts": {...}, "probabilities": {...}}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.post("/session/new", response_model=SessionResponse)
async def new_session():
    """Create a brand-new session and return its UUID to the client."""
    sid = str(uuid.uuid4())
    _get_session(sid)           # eagerly initialise so the WS is ready to receive
    return {"session_id": sid}


@router.get("/session/{session_id}/snapshots")
async def get_snapshots(session_id: str):
    """Return the full ordered list of statevector snapshots (for playback mode)."""
    session = _get_session(session_id)
    return {"snapshots": session["snapshots"]}


@router.post("/command", response_model=CommandResponse)
async def handle_command(req: CommandRequest):
    """
    Parse and execute one terminal command.

    Returns synchronous output immediately; long-running work (Shor steps,
    hardware polling) continues in background tasks and pushes updates via
    the WebSocket.
    """
    session  = _get_session(req.session_id)
    parser   = session["parser"]
    cm: CircuitManager = session["circuit_manager"]
    nm: NoiseManager   = session["noise_manager"]

    raw = req.command.strip()
    if not raw:
        return CommandResponse(success=True, lines=[])

    parsed: Optional[ParsedCommand] = parser.parse(raw)

    if parsed is None:
        return CommandResponse(
            success=False,
            lines=[f"[error] Unrecognised command: {raw}",
                   "        Type 'help' for a list of commands."]
        )

    # The parser emits op="error" when the command was recognised but args
    # were malformed (e.g. "apply H" without a qubit index).  Surface the
    # message directly so the user gets actionable feedback.
    if parsed.operation == "error":
        return CommandResponse(
            success=False,
            lines=[f"[error] {parsed.args.get('message', 'Invalid command syntax.')}"]
        )

    return await _dispatch(parsed, session, req.session_id, raw)


# ---------------------------------------------------------------------------
# Command dispatcher
# ---------------------------------------------------------------------------
async def _dispatch(cmd: ParsedCommand, session: dict, sid: str, raw: str) -> CommandResponse:
    cm: CircuitManager   = session["circuit_manager"]
    nm: NoiseManager     = session["noise_manager"]
    hw: HardwareManager  = session["hardware_manager"]
    snapshots: list      = session["snapshots"]

    op = cmd.operation

    # ---- init ---------------------------------------------------------------
    if op == "init":
        n = cmd.args.get("n", 1)
        cm.init(n)
        sv = _capture_and_push(cm, nm, session, sid)
        return CommandResponse(
            success=True,
            lines=[f"[init] Initialised {n}-qubit register |{'0'*n}⟩",
                   f"       Hilbert space dimension: 2^{n} = {2**n}"],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- reset --------------------------------------------------------------
    if op == "reset":
        n = cm.num_qubits
        cm.init(n)
        session["snapshots"].clear()
        sv = _capture_and_push(cm, nm, session, sid)
        return CommandResponse(
            success=True,
            lines=["[reset] Circuit cleared — register returned to |0⟩ state."],
            statevector=sv,
            circuit_ops=[],
        )

    # ---- apply gate ---------------------------------------------------------
    if op == "apply":
        gate  = cmd.args["gate"]
        qargs = cmd.args["qubits"]

        try:
            cm.apply_gate(gate, qargs)
        except ValueError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        sv = _capture_and_push(cm, nm, session, sid)
        q_label = ", ".join(str(q) for q in qargs)
        return CommandResponse(
            success=True,
            lines=[f"[gate] Applied {gate} to qubit(s) {q_label}",
                   f"       Circuit depth: {cm.depth()}"],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- apply rotation gate ------------------------------------------------
    if op == "apply_rot":
        import math
        gate  = cmd.args["gate"]
        qargs = cmd.args["qubits"]
        theta = cmd.args["theta"]         # radians
        deg   = round(math.degrees(theta), 2)

        try:
            cm.apply_gate(gate, qargs, theta=theta)
        except ValueError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        sv = _capture_and_push(cm, nm, session, sid)
        return CommandResponse(
            success=True,
            lines=[f"[gate] Applied {gate}({deg}°) to qubit {qargs[0]}",
                   f"       Rotates state by {deg}° around the {'X' if gate=='RX' else 'Y' if gate=='RY' else 'Z'}-axis of the Bloch sphere.",
                   f"       Circuit depth: {cm.depth()}"],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- sv — print statevector amplitudes ----------------------------------
    if op == "sv":
        if cm.num_qubits == 0:
            return CommandResponse(success=False,
                                   lines=["[error] No circuit — run 'init <n>' first."])
        try:
            sv_arr = cm.statevector(noise_model=nm.get_model() if nm.active else None)
        except RuntimeError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        import math, cmath
        lines = [f"[sv] Statevector ({cm.num_qubits} qubits, {len(sv_arr)} amplitudes):"]
        for i, amp in enumerate(sv_arr):
            basis  = format(i, f"0{cm.num_qubits}b")
            mag    = abs(amp)
            phase  = math.degrees(cmath.phase(amp))
            prob   = mag ** 2
            if mag < 1e-9:
                continue    # skip zero-amplitude terms for readability
            bar = "▓" * int(prob * 20)
            lines.append(f"  |{basis}⟩  {amp.real:+.4f}{amp.imag:+.4f}i  "
                         f"p={prob:.4f}  φ={phase:+.1f}°  {bar}")
        if len(lines) == 1:
            lines.append("  (all amplitudes are zero — circuit may not be initialised)")
        return CommandResponse(success=True, lines=lines)

    # ---- measure ------------------------------------------------------------
    if op == "measure":
        try:
            counts, probs = cm.measure(noise_model=nm.get_model())
        except RuntimeError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        lines = ["[measure] Measurement results:"]
        for outcome, count in sorted(counts.items()):
            bar = "█" * int(probs[outcome] * 30)
            lines.append(f"  |{outcome}⟩  {bar}  {count} shots  ({probs[outcome]:.3f})")

        # push histogram update over WS
        asyncio.create_task(ws_manager.send(sid, {
            "type": "histogram",
            "data": {"counts": counts, "probabilities": probs}
        }))

        return CommandResponse(
            success=True,
            lines=lines,
            histogram={"counts": counts, "probabilities": probs},
        )

    # ---- noise on/off/level -------------------------------------------------
    if op == "noise_on":
        nm.enable()
        return CommandResponse(
            success=True,
            lines=["[noise] Noise model ENABLED",
                   f"        Error rate: {nm.error_rate:.4f} (depolarising + phase-flip)"]
        )

    if op == "noise_off":
        nm.disable()
        return CommandResponse(
            success=True,
            lines=["[noise] Noise model DISABLED — ideal simulator active."]
        )

    if op == "noise_level":
        rate = cmd.args["level"]
        nm.set_rate(rate)
        return CommandResponse(
            success=True,
            lines=[f"[noise] Error rate set to {rate:.4f}",
                   "        Changes apply to the next gate execution."]
        )

    # ---- Hamiltonian time evolution -----------------------------------------
    if op == "hamiltonian":
        if cm.num_qubits == 0:
            return CommandResponse(success=False,
                                   lines=["[error] Run 'init <n>' first."])
        H_expr = cmd.args["H_expr"]
        t      = cmd.args["t"]
        steps  = cmd.args["steps"]

        # Validate the expression before launching the background task
        try:
            terms = parse_hamiltonian(H_expr)
        except ValueError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        asyncio.create_task(_run_hamiltonian(H_expr, t, steps, sid, session))
        return CommandResponse(
            success=True,
            lines=[
                f"[hamiltonian] Evolving under H = {H_expr}",
                f"              t = {t}  ({steps} steps)",
                "              Step trace streaming over WebSocket…",
            ],
        )

    # ---- Eigenvalue analysis -------------------------------------------------
    if op == "eigenvalues":
        if cm.num_qubits == 0:
            return CommandResponse(success=False,
                                   lines=["[error] Run 'init <n>' first."])
        H_expr = cmd.args["H_expr"]
        try:
            terms = parse_hamiltonian(H_expr)
            H_mat = build_hamiltonian_matrix(terms, cm.num_qubits)
            psi   = cm.statevector()
            result = eigenvalue_analysis(H_mat, psi, cm.num_qubits)
        except (ValueError, RuntimeError) as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        eigs = result["eigenvalues"]
        lines = [
            f"[eigenvalues] Hamiltonian H = {H_expr}",
            f"              Dimension: {2**cm.num_qubits} × {2**cm.num_qubits}",
            "              Energy spectrum:",
        ]
        for i, e in enumerate(eigs[:16]):
            bar = "▓" * int(max(0, (e - eigs[0]) / max(eigs[-1] - eigs[0], 0.001) * 20))
            lines.append(f"  E{i} = {e:+.6f}  {bar}")
        lines += [
            f"",
            f"  Ground state energy : E₀ = {result['ground_energy']}",
            f"  Energy gap          : ΔE = {result['energy_gap']}",
            f"  Expectation ⟨ψ|H|ψ⟩ : {result['expectation']}",
        ]
        return CommandResponse(success=True, lines=lines)

    # ---- run shor (sim) -----------------------------------------------------
    if op == "shor_sim":
        N = cmd.args["N"]
        asyncio.create_task(_run_shor_sim(N, sid, session))
        return CommandResponse(
            success=True,
            lines=[
                f"[shor] Starting Shor's algorithm for N={N}  (simulator mode)",
                "       Step-by-step trace will stream over WebSocket…",
            ]
        )

    # ---- run shor (real hardware) -------------------------------------------
    if op == "shor_real":
        N = cmd.args["N"]
        asyncio.create_task(_run_shor_real(N, sid, session, hw))
        return CommandResponse(
            success=True,
            lines=[
                f"[shor] Submitting Shor's algorithm for N={N} to IBM Quantum hardware.",
                "       Job status updates will stream over WebSocket…",
            ]
        )

    # ---- init bell ----------------------------------------------------------
    if op == "init_bell":
        cm.init_bell()
        sv = _capture_and_push(cm, nm, session, sid)
        return CommandResponse(
            success=True,
            lines=[
                "[bell] Prepared |Φ+⟩ Bell state on 2 qubits:",
                "       |Φ+⟩ = (|00⟩ + |11⟩) / √2",
                "       Maximally entangled — concurrence C = 1.0",
            ],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- init ghz -----------------------------------------------------------
    if op == "init_ghz":
        n = cmd.args["n"]
        cm.init_ghz(n)
        sv = _capture_and_push(cm, nm, session, sid)
        return CommandResponse(
            success=True,
            lines=[
                f"[ghz] Prepared {n}-qubit GHZ state:",
                f"      (|{'0'*n}⟩ + |{'1'*n}⟩) / √2",
                f"      {n} qubits — maximally multipartite entangled.",
            ],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- run qft ------------------------------------------------------------
    if op == "qft":
        if cm.num_qubits == 0:
            return CommandResponse(success=False, lines=["[error] Run 'init <n>' first."])
        n = cmd.args.get("n") or cm.num_qubits
        try:
            cm.apply_qft(n)
        except ValueError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])
        sv = _capture_and_push(cm, nm, session, sid)
        return CommandResponse(
            success=True,
            lines=[
                f"[qft] Applied Quantum Fourier Transform over {n} qubits.",
                f"      QFT circuit depth: {cm.depth()}",
                "      Use 'measure' to sample the QFT output distribution.",
            ],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- run grover ---------------------------------------------------------
    if op == "grover":
        if cm.num_qubits == 0:
            return CommandResponse(success=False, lines=["[error] Run 'init <n>' first."])
        target = cmd.args["target"]
        if len(target) != cm.num_qubits:
            return CommandResponse(
                success=False,
                lines=[f"[error] Target must be {cm.num_qubits} bits, got '{target}'.",
                       f"        Example: run grover target={'1' * cm.num_qubits}"]
            )
        try:
            # Put into uniform superposition if all-zero circuit
            import math
            sv_now = cm.statevector()
            # Apply H to all qubits first if state is |0...0>
            is_zero_state = abs(sv_now[0] - 1.0) < 1e-6
            if is_zero_state:
                for q in range(cm.num_qubits):
                    cm.apply_gate("H", [q])
            # Number of optimal iterations: floor(π/4 * √N)
            n_iter = max(1, round(math.pi / 4 * math.sqrt(2 ** cm.num_qubits)))
            for _ in range(n_iter):
                cm.apply_grover(target)
            sv = _capture_and_push(cm, nm, session, sid)
        except (ValueError, RuntimeError) as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        import numpy as np
        sv_arr = cm.statevector()
        idx    = int(target[::-1], 2)    # little-endian
        prob   = float(abs(sv_arr[idx]) ** 2)
        return CommandResponse(
            success=True,
            lines=[
                f"[grover] Grover search for |{target}⟩  ({n_iter} iterations)",
                f"         Success probability: {prob:.4f} ({prob*100:.1f}%)",
                f"         Run 'measure' to observe the result.",
            ],
            statevector=sv,
            circuit_ops=cm.gate_list(),
        )

    # ---- entropy ------------------------------------------------------------
    if op == "entropy":
        if cm.num_qubits == 0:
            return CommandResponse(success=False, lines=["[error] Run 'init <n>' first."])
        try:
            import numpy as np
            sv_arr = cm.statevector(noise_model=nm.get_model() if nm.active else None)
            report = entanglement_report(sv_arr, cm.num_qubits)
        except Exception as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        lines = ["[entropy] Von Neumann entropy (entanglement measure):"]
        for entry in report["per_qubit_entropy"]:
            bar = "▓" * int(entry["entropy"] * 20)
            lines.append(f"  qubit {entry['qubit']}:  S = {entry['entropy']:.6f} bits  {bar}")
        lines.append(f"  Average entropy: {report['average_entropy']:.6f} bits")
        if "concurrence" in report:
            c = report["concurrence"]
            lines.append(f"  Concurrence C = {c:.6f}  ({'maximally entangled' if c > 0.99 else 'separable' if c < 0.01 else 'partially entangled'})")
        return CommandResponse(success=True, lines=lines)

    # ---- fidelity -----------------------------------------------------------
    if op == "fidelity":
        if cm.num_qubits == 0:
            return CommandResponse(success=False, lines=["[error] Run 'init <n>' first."])
        target = cmd.args["target"]
        try:
            sv_arr = cm.statevector(noise_model=nm.get_model() if nm.active else None)
            f = calc_fidelity(sv_arr, target)
        except ValueError as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])

        bar = "█" * int(f * 30)
        lines = [
            f"[fidelity] F(|ψ⟩, |{target}⟩) = {f:.6f}",
            f"           {bar}",
            f"           {'Perfect match ✓' if f > 0.999 else f'{f*100:.2f}% probability of measuring |{target}⟩'}",
        ]
        return CommandResponse(success=True, lines=lines)

    # ---- depth --------------------------------------------------------------
    if op == "depth":
        if cm.num_qubits == 0:
            return CommandResponse(success=False, lines=["[error] Run 'init <n>' first."])
        d  = cm.depth()
        ng = len(cm.gate_list())
        return CommandResponse(
            success=True,
            lines=[
                f"[depth] Circuit statistics:",
                f"        Qubits        : {cm.num_qubits}",
                f"        Total gates   : {ng}",
                f"        Circuit depth : {d}",
                f"        Hilbert space : 2^{cm.num_qubits} = {2**cm.num_qubits} dims",
            ]
        )

    # ---- export (QASM) ------------------------------------------------------
    if op == "export":
        if cm.num_qubits == 0:
            return CommandResponse(success=False, lines=["[error] Run 'init <n>' first."])
        try:
            qasm = cm.to_qasm()
        except Exception as exc:
            return CommandResponse(success=False, lines=[f"[error] {exc}"])
        lines = ["[export] OpenQASM 2.0 circuit:"] + qasm.strip().split("\n")
        return CommandResponse(success=True, lines=lines)

    # ---- help ---------------------------------------------------------------
    if op == "help":
        return CommandResponse(
            success=True,
            lines=_help_lines(),
        )

    return CommandResponse(success=False, lines=[f"[error] Unhandled op: {op}"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _capture_and_push(cm: CircuitManager, nm: NoiseManager,
                      session: dict, sid: str) -> list:
    """Run statevector sim, record snapshot, push WS event, return SV list."""
    sv_complex = cm.statevector(noise_model=nm.get_model() if nm.active else None)
    sv_serial  = [{"re": float(c.real), "im": float(c.imag)} for c in sv_complex]

    # record for playback
    session["snapshots"].append({
        "statevector": sv_serial,
        "circuit_ops": cm.gate_list(),
    })

    # fire-and-forget — route does not await this
    asyncio.create_task(ws_manager.send(sid, {
        "type": "statevector",
        "data": {"statevector": sv_serial, "circuit_ops": cm.gate_list()}
    }))
    return sv_serial


async def _run_hamiltonian(H_expr: str, t: float, steps: int, sid: str, session: dict):
    """Background task: stream Hamiltonian evolution steps and update circuit state."""
    import numpy as np
    cm: CircuitManager = session["circuit_manager"]
    try:
        psi = cm.statevector()
    except RuntimeError as exc:
        await ws_manager.send(sid, {"type": "error", "data": {"message": str(exc)}})
        return

    async for step in hamiltonian_steps(H_expr, psi, cm.num_qubits, t, steps):
        await ws_manager.send(sid, {"type": "hamiltonian_step", "data": step})

        # When the step contains the final evolved statevector, store it and
        # push a statevector event so the Bloch sphere updates immediately.
        if "statevector" in step and not step.get("error"):
            sv = step["statevector"]
            session["snapshots"].append({"statevector": sv, "circuit_ops": cm.gate_list()})
            await ws_manager.send(sid, {
                "type": "statevector",
                "data": {"statevector": sv, "circuit_ops": cm.gate_list()},
            })


async def _run_shor_sim(N: int, sid: str, session: dict):
    """Background task: stream Shor's algorithm steps over WebSocket."""
    cm: CircuitManager = session["circuit_manager"]
    shor = ShorAlgorithm(N)

    async for step in shor.run_sim():
        await ws_manager.send(sid, {"type": "shor_step", "data": step})
        await asyncio.sleep(0.6)      # pacing — gives the UI time to render each step

    # After Shor finishes, update the circuit panel with the QFT circuit
    if shor.circuit is not None:
        session["circuit_manager"] = cm   # preserve the user's own circuit
        await ws_manager.send(sid, {
            "type": "output",
            "data": {"lines": ["[shor] Algorithm complete."]}
        })


async def _run_shor_real(N: int, sid: str, session: dict, hw: HardwareManager):
    """Background task: submit to IBM Quantum and poll for updates."""
    try:
        async for event in hw.run_shor(N):
            await ws_manager.send(sid, event)
            await asyncio.sleep(5)    # poll interval
    except Exception as exc:
        await ws_manager.send(sid, {
            "type": "error",
            "data": {"message": str(exc)}
        })


def _help_lines() -> list[str]:
    return [
        "┌──────────────────────────────────────────────────────────────────┐",
        "│              QUANTUM HACKER TERMINAL — HELP                      │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  CIRCUIT CONSTRUCTION                                            │",
        "│  init [n]                Initialise n-qubit register (1–16)     │",
        "│  reset                   Reset circuit to |0⟩                   │",
        "│  apply H  <q>            Hadamard gate on qubit q               │",
        "│  apply X  <q>            Pauli-X (bit flip)                     │",
        "│  apply Y  <q>            Pauli-Y                                │",
        "│  apply Z  <q>            Pauli-Z (phase flip)                   │",
        "│  apply S/T/SX <q>        S, T, √X gates                        │",
        "│  apply RX(<deg>) <q>     Rotate <deg>° around X-axis           │",
        "│  apply RY(<deg>) <q>     Rotate <deg>° around Y-axis           │",
        "│  apply RZ(<deg>) <q>     Rotate <deg>° around Z-axis           │",
        "│  apply CNOT <c> <t>      CNOT — control c, target t            │",
        "│  apply CZ   <c> <t>      Controlled-Z                          │",
        "│  apply SWAP <a> <b>      Swap two qubits                       │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  SIMULATION & ANALYSIS                                           │",
        "│  measure                 Measure all qubits (1024 shots)        │",
        "│  sv                      Print statevector amplitudes           │",
        "│  run shor N=<n> mode=sim    Shor's algorithm, simulator        │",
        "│  run shor N=<n> mode=real   Shor's algorithm, IBM Quantum      │",
        "│    (supported N: 15, 21, 33, 35)                               │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  NOISE                                                           │",
        "│  noise on                Enable depolarising noise (p=0.01)    │",
        "│  noise off               Disable noise model                   │",
        "│  noise level=<0–1>       Set error probability                 │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  UTILITY                                                         │",
        "│  clear                   Clear terminal output                  │",
        "│  help                    Show this reference                    │",
        "│  HAMILTONIAN & EIGENVALUES                                       │",
        "│  run hamiltonian H=<expr> t=<float> [steps=<int>]              │",
        "│      Evolve |ψ⟩ under e^{-iHt}.  Pauli expr e.g: Z0 or X0Z1  │",
        "│  run eigenvalues H=<expr>                                       │",
        "│      Diagonalise H and show spectrum + ⟨ψ|H|ψ⟩                │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  STATE PREPARATION SHORTCUTS                                      │",
        "│  init bell               Prepare |Φ+⟩ = (|00⟩+|11⟩)/√2       │",
        "│  init ghz <n>            Prepare n-qubit GHZ state             │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  ALGORITHMS                                                       │",
        "│  run qft [n]             Quantum Fourier Transform              │",
        "│  run grover target=<bits>  Grover search (auto-iterate)        │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  INFORMATION THEORY                                               │",
        "│  entropy                 Von Neumann entropy per qubit          │",
        "│  fidelity <bits>         |⟨target|ψ⟩|² overlap                │",
        "│  depth                   Circuit depth + gate count             │",
        "│  export                  Print circuit as OpenQASM 2.0         │",
        "├──────────────────────────────────────────────────────────────────┤",
        "│  TIPS                                                            │",
        "│  Chain commands on one line: init 2 apply H 0 measure          │",
        "│  Gate buttons above the input auto-fill commands for you       │",
        "└──────────────────────────────────────────────────────────────────┘",
    ]
