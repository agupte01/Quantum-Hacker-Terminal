"""
Quantum DSL parser for the Quantum Hacker Terminal.

The grammar is intentionally simple — a small set of fixed keywords followed
by typed arguments.  We tokenise with a single regex split and then match
against each pattern in order, which is easy to extend without pulling in a
full grammar library.

Supported surface syntax (case-insensitive keywords, space-separated):
  init [n]
  reset
  apply H  <q>
  apply X  <q>
  apply Y  <q>
  apply Z  <q>
  apply CNOT <control> <target>
  measure
  run shor N=<int> mode=sim|real
  noise on
  noise off
  noise level=<float>
  help
"""

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


# ---------------------------------------------------------------------------
# Parsed result container
# ---------------------------------------------------------------------------
@dataclass
class ParsedCommand:
    operation: str                      # canonical op name (e.g. "apply", "init")
    args: Dict[str, Any] = field(default_factory=dict)
    raw: str = ""


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
class CommandParser:
    """Stateless, regex-based parser.  Call parse() with one command string."""

    # Each entry: (compiled_regex, operation_name, arg_extractor_callable)
    _RULES: list = []     # built lazily on first use

    def __init__(self):
        self._rules = _build_rules()

    def parse(self, raw: str) -> Optional[ParsedCommand]:
        """
        Tokenise raw command and return a ParsedCommand, or None if no rule
        matches.  Matching is case-insensitive on keywords.

        Pre-processing: strip angle brackets so users can type either
        `apply H 0` or `apply H <0>` interchangeably, as the help text
        uses <q> as a placeholder notation.
        """
        s = raw.strip()
        # Remove angle-bracket placeholders (e.g. <1> → 1, <0.05> → 0.05)
        s = re.sub(r"<(\w*\.?\w+)>", r"\1", s)

        for pattern, op, extractor in self._rules:
            m = pattern.match(s)
            if m:
                try:
                    args = extractor(m) if extractor else {}
                    return ParsedCommand(operation=op, args=args, raw=raw)
                except (ValueError, IndexError) as exc:
                    # Pattern matched but args were malformed (e.g. non-integer qubit)
                    return ParsedCommand(
                        operation="error",
                        args={"message": str(exc)},
                        raw=raw,
                    )
        return None


# ---------------------------------------------------------------------------
# Rule table
# ---------------------------------------------------------------------------
def _build_rules() -> list:
    """
    Return a list of (pattern, op_name, arg_extractor) tuples.
    Patterns are matched with re.match (anchored at the start; we add $ at
    the end for each rule to require a full-string match).
    """
    F = re.IGNORECASE

    def pat(s: str):
        return re.compile(s + r"\s*$", F)

    rules = []

    # --- help ---------------------------------------------------------------
    rules.append((pat(r"help"), "help", None))

    # --- init [n] -----------------------------------------------------------
    def _init(m):
        n = int(m.group(1)) if m.group(1) else 1
        if not (1 <= n <= 16):
            raise ValueError(f"Qubit count must be between 1 and 16, got {n}")
        return {"n": n}
    rules.append((pat(r"init(?:\s+(\d+))?"), "init", _init))

    # --- reset --------------------------------------------------------------
    rules.append((pat(r"reset"), "reset", None))

    # --- apply <gate> <q> [q2] ----------------------------------------------
    SINGLE_GATES = r"(H|X|Y|Z|S|T|SX|SDG|TDG)"
    TWO_QUBIT    = r"(CNOT|CX|CZ|SWAP)"
    ROT_GATES    = r"(RX|RY|RZ)"   # rotation gates take an angle argument

    def _apply_single(m):
        return {"gate": m.group(1).upper(), "qubits": [_qubit(m.group(2))]}
    def _apply_two(m):
        return {"gate": m.group(1).upper(),
                "qubits": [_qubit(m.group(2)), _qubit(m.group(3))]}
    # Rotation gate: apply Rx(theta) <q>  — angle in degrees for human convenience
    def _apply_rot(m):
        gate  = m.group(1).upper()
        theta = float(m.group(2))   # degrees
        q     = _qubit(m.group(3))
        import math
        return {"gate": gate, "qubits": [q], "theta": math.radians(theta)}

    rules.append((pat(rf"apply\s+{SINGLE_GATES}\s+(\d+)"),                     "apply",     _apply_single))
    rules.append((pat(rf"apply\s+{TWO_QUBIT}\s+(\d+)\s+(\d+)"),                "apply",     _apply_two))
    rules.append((pat(rf"apply\s+{ROT_GATES}\s*\(?\s*(-?[\d.]+)\s*\)?\s+(\d+)"), "apply_rot", _apply_rot))

    # --- catch-all: apply <gate> missing qubit index ------------------------
    # These must come AFTER the valid rules so they only fire on partial input.
    def _apply_single_missing_qubit(m):
        gate = m.group(1).upper()
        raise ValueError(
            f"'apply {gate}' requires a qubit index.  Example: apply {gate} 0"
        )
    def _apply_two_missing_qubit(m):
        gate = m.group(1).upper()
        raise ValueError(
            f"'apply {gate}' requires two qubit indices.  Example: apply {gate} 0 1"
        )
    def _apply_unknown_gate(m):
        gate = m.group(1)
        raise ValueError(
            f"Unknown gate '{gate}'.  Supported single-qubit: H X Y Z S T SX SDG TDG  "
            f"Two-qubit: CNOT CX CZ SWAP"
        )

    rules.append((pat(rf"apply\s+{SINGLE_GATES}"),    "error", _apply_single_missing_qubit))
    rules.append((pat(rf"apply\s+{TWO_QUBIT}"),        "error", _apply_two_missing_qubit))
    rules.append((pat(rf"apply\s+{ROT_GATES}"),        "error",
                  lambda m: (_ for _ in ()).throw(ValueError(
                      f"'apply {m.group(1).upper()}' requires angle and qubit.  "
                      f"Example: apply {m.group(1).upper()}(45) 0"))))
    rules.append((pat(r"apply\s+(\S+).*"),             "error", _apply_unknown_gate))

    # --- measure ------------------------------------------------------------
    rules.append((pat(r"measure"), "measure", None))

    # --- run shor N=<int> mode=sim|real -------------------------------------
    def _shor_sim(m):
        return {"N": _valid_shor_n(int(m.group(1)))}
    def _shor_real(m):
        return {"N": _valid_shor_n(int(m.group(1)))}

    rules.append((pat(r"run\s+shor\s+N=(\d+)\s+mode=sim"),  "shor_sim",  _shor_sim))
    rules.append((pat(r"run\s+shor\s+N=(\d+)\s+mode=real"), "shor_real", _shor_real))

    # --- sv — print statevector amplitudes -----------------------------------
    rules.append((pat(r"sv"), "sv", None))

    # --- run hamiltonian H=<expr> t=<float> [steps=<int>] -------------------
    def _hamiltonian(m):
        expr   = m.group(1).strip()
        t      = float(m.group(2))
        steps  = int(m.group(3)) if m.group(3) else 8
        if not (0 < abs(t) <= 100):
            raise ValueError("t must be non-zero and ≤ 100")
        if not (1 <= steps <= 64):
            raise ValueError("steps must be between 1 and 64")
        return {"H_expr": expr, "t": t, "steps": steps}

    rules.append((pat(
        r"run\s+hamiltonian\s+H=(.+?)\s+t=(-?[\d.]+)(?:\s+steps=(\d+))?"),
        "hamiltonian", _hamiltonian,
    ))

    # --- run eigenvalues H=<expr> -------------------------------------------
    def _eigenvalues(m):
        return {"H_expr": m.group(1).strip()}

    rules.append((pat(r"run\s+eigenvalues\s+H=(.+)"), "eigenvalues", _eigenvalues))

    # --- init bell / ghz N -------------------------------------------------
    rules.append((pat(r"init\s+bell"), "init_bell", None))

    def _ghz(m):
        n = int(m.group(1))
        if not (2 <= n <= 10):
            raise ValueError("GHZ requires 2–10 qubits.")
        return {"n": n}
    rules.append((pat(r"init\s+ghz\s+(\d+)"), "init_ghz", _ghz))

    # --- run qft [n] -------------------------------------------------------
    def _qft(m):
        return {"n": int(m.group(1)) if m.group(1) else None}
    rules.append((pat(r"run\s+qft(?:\s+(\d+))?"), "qft", _qft))

    # --- run grover target=<bitstr> -----------------------------------------
    def _grover(m):
        target = m.group(1).strip()
        if not all(c in "01" for c in target):
            raise ValueError("Target must be a binary string e.g. grover target=101")
        return {"target": target}
    rules.append((pat(r"run\s+grover\s+target=([01]+)"), "grover", _grover))

    # --- entropy [qubit] ---------------------------------------------------
    def _entropy(m):
        return {"qubit": int(m.group(1)) if m.group(1) else None}
    rules.append((pat(r"entropy(?:\s+(\d+))?"), "entropy", _entropy))

    # --- fidelity <bitstring> ----------------------------------------------
    def _fidelity(m):
        return {"target": m.group(1).strip()}
    rules.append((pat(r"fidelity\s+([01]+)"), "fidelity", _fidelity))

    # --- depth -------------------------------------------------------------
    rules.append((pat(r"depth"), "depth", None))

    # --- export ------------------------------------------------------------
    rules.append((pat(r"export"), "export", None))

    # --- noise on / off / level=<float> -------------------------------------
    rules.append((pat(r"noise\s+on"),  "noise_on",  None))
    rules.append((pat(r"noise\s+off"), "noise_off", None))

    def _noise_level(m):
        rate = float(m.group(1))
        if not (0.0 <= rate <= 1.0):
            raise ValueError(f"Noise level must be in [0.0, 1.0], got {rate}")
        return {"level": rate}
    rules.append((pat(r"noise\s+level=(\d*\.?\d+)"), "noise_level", _noise_level))

    return rules


# ---------------------------------------------------------------------------
# Argument validators
# ---------------------------------------------------------------------------
def _qubit(s: str) -> int:
    q = int(s)
    if q < 0:
        raise ValueError(f"Qubit index must be non-negative, got {q}")
    return q


def _valid_shor_n(n: int) -> int:
    supported = {15, 21, 33, 35}
    if n not in supported:
        raise ValueError(
            f"N={n} is not supported. Choose one of: {sorted(supported)}"
        )
    return n
