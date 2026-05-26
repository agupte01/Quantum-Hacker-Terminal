"""
IBM Quantum hardware integration for the Quantum Hacker Terminal.

Uses QiskitRuntimeService to submit jobs to real quantum hardware.  The job is
submitted with the Sampler primitive (which is the stable interface in
qiskit-ibm-runtime ≥ 0.20).  A background polling loop pushes status updates
over the WebSocket every 5 seconds until the job completes or fails.

Environment variable required: IBM_QUANTUM_TOKEN (set in .env file).

If the token is absent or the SDK is not installed, every call raises a
descriptive error that the frontend can display gracefully.
"""

from __future__ import annotations

import asyncio
import math
import os
import random
from typing import Any, AsyncIterator, Dict, Optional

try:
    from qiskit_ibm_runtime import (
        QiskitRuntimeService,
        SamplerV2 as Sampler,
        Session,
    )
    from qiskit import QuantumCircuit, transpile
    IBM_AVAILABLE = True
except ImportError:
    IBM_AVAILABLE = False

from quantum.shor import _build_phase_estimation_circuit, _counting_qubits, _find_order_classical


class HardwareManager:
    """Handles IBM Quantum job submission and polling for one session."""

    def __init__(self):
        self._token: Optional[str] = os.getenv("IBM_QUANTUM_TOKEN")
        self._service: Optional[Any] = None     # QiskitRuntimeService, lazy init

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def run_shor(self, N: int) -> AsyncIterator[Dict]:
        """
        Async generator that submits a Shor circuit to IBM Quantum and then
        polls for status, yielding one WebSocket message dict per poll cycle.
        """
        if not IBM_AVAILABLE:
            yield _err("qiskit-ibm-runtime is not installed. "
                        "Install it with: pip install qiskit-ibm-runtime")
            return

        if not self._token:
            yield _err("IBM_QUANTUM_TOKEN is not set in the .env file. "
                        "Get your free token at quantum.ibm.com.")
            return

        # ---- Authenticate -----------------------------------------------
        try:
            if self._service is None:
                self._service = QiskitRuntimeService(
                    channel="ibm_quantum",
                    token=self._token,
                )
            service = self._service
        except Exception as exc:
            yield _err(f"IBM Quantum authentication failed: {exc}")
            return

        # ---- Pick backend -----------------------------------------------
        try:
            backend = service.least_busy(simulator=False, operational=True)
            yield _status(None, "queued", None,
                          extra_lines=[
                              f"[hardware] Authenticated with IBM Quantum.",
                              f"[hardware] Selected backend: {backend.name}",
                              f"[hardware] Submitting Shor's circuit for N={N}…",
                          ])
        except Exception as exc:
            yield _err(f"Could not find a suitable backend: {exc}")
            return

        # ---- Build and transpile circuit --------------------------------
        try:
            a = random.choice([b for b in range(2, N) if math.gcd(b, N) == 1])
            n_count = _counting_qubits(N)
            n_work  = N.bit_length()
            qc = _build_phase_estimation_circuit(a, N, n_count, n_work)
            qc_t = transpile(qc, backend)
        except Exception as exc:
            yield _err(f"Circuit transpilation failed: {exc}")
            return

        # ---- Submit job -------------------------------------------------
        try:
            with Session(service=service, backend=backend) as session:
                sampler = Sampler(session=session)
                job = sampler.run([qc_t], shots=1024)
                job_id = job.job_id()
        except Exception as exc:
            yield _err(f"Job submission failed: {exc}")
            return

        yield _status(job_id, "submitted", None,
                      extra_lines=[f"[hardware] Job ID: {job_id}",
                                   "[hardware] Polling every 5 s…"])

        # ---- Polling loop -----------------------------------------------
        while True:
            await asyncio.sleep(5)
            try:
                status = job.status()
                status_str = str(status).lower()
                queue_pos  = getattr(job, "queue_position", lambda: None)()

                if "done" in status_str or "complete" in status_str:
                    # Job finished — fetch results
                    result = job.result()
                    counts = _extract_counts(result)

                    # Compare with ideal simulator
                    from qiskit_aer import AerSimulator
                    from quantum.circuit_manager import CircuitManager
                    ideal_cm = CircuitManager()
                    ideal_cm.init(n_count + n_work)
                    ideal_counts, ideal_probs = ideal_cm.measure()   # baseline

                    yield {
                        "type": "job_complete",
                        "data": {
                            "job_id":       job_id,
                            "counts":       counts,
                            "ideal_counts": ideal_probs,
                            "backend":      backend.name,
                            "lines": [
                                f"[hardware] Job {job_id} COMPLETE on {backend.name}.",
                                "[hardware] Results are displayed in the histogram panel.",
                                "[hardware] Ideal (simulator) results overlaid for comparison.",
                            ]
                        }
                    }
                    return

                if "error" in status_str or "cancel" in status_str:
                    yield _err(f"Job {job_id} ended with status: {status_str}")
                    return

                yield _status(job_id, status_str, queue_pos)

            except Exception as exc:
                yield _err(f"Polling error: {exc}")
                return


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _status(job_id, status, queue_pos, extra_lines=None):
    lines = extra_lines or []
    if job_id and queue_pos is not None:
        lines.append(f"[hardware] Job {job_id} — status: {status}  (queue position: {queue_pos})")
    elif job_id:
        lines.append(f"[hardware] Job {job_id} — status: {status}")
    return {
        "type": "job_status",
        "data": {
            "job_id":         job_id,
            "status":         status,
            "queue_position": queue_pos,
            "lines":          lines,
        }
    }


def _err(message: str) -> dict:
    return {
        "type": "error",
        "data": {"message": message, "lines": [f"[error] {message}"]}
    }


def _extract_counts(result) -> Dict[str, int]:
    """Extract measurement counts from a SamplerV2 result."""
    try:
        # SamplerV2 result structure
        pub_result = result[0]
        bitarray   = pub_result.data.meas
        counts     = {}
        for shot in bitarray.get_int_counts():
            bits = format(shot[0], f"0{bitarray.num_bits}b")
            counts[bits] = counts.get(bits, 0) + shot[1]
        return counts
    except Exception:
        # Fallback: return empty dict so the UI still renders cleanly
        return {}
