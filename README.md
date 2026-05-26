# ⬡ Quantum Hacker Terminal

A browser-based, terminal-style quantum computing simulator with real-time visualisation. Run quantum circuits, explore entanglement, simulate quantum algorithms, and — if you have IBM Quantum credentials — execute on real hardware, all from a sleek hacker-aesthetic interface.

---

## Screenshots

The interface is a **2 × 2 panel grid** surrounded by a live status bar:

| Panel | Description |
|-------|-------------|
| **Terminal** (top-left) | DSL command input with syntax highlighting, gate quick-buttons, and streaming output |
| **Bloch Sphere** (top-right) | Interactive Three.js Bloch sphere with SLERP animation, scroll/button zoom, purity readout |
| **Circuit Diagram** (bottom-left) | Live SVG circuit diagram updated after every gate |
| **Histogram** (bottom-right) | Probability / count bar chart with mode toggle and rotated labels |

---

## Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Python | ≥ 3.10 |
| Node.js | ≥ 18 |
| pip / venv | any |

### Install & Run

```bash
# 1. Clone
git clone <repo-url>
cd QuantumHackerTerminal

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 3. Frontend (new terminal tab)
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

---

## Command Reference

### Circuit Construction

```
init [n]                 Initialise n-qubit register |0…0⟩  (1–16 qubits)
reset                    Reset circuit to |0⟩, clear history

apply H  <q>             Hadamard gate
apply X  <q>             Pauli-X (bit flip)
apply Y  <q>             Pauli-Y
apply Z  <q>             Pauli-Z (phase flip)
apply S  <q>             S gate  (phase = π/2)
apply T  <q>             T gate  (phase = π/4)
apply SX <q>             √X gate
apply SDG / TDG <q>      Inverse S / T gates

apply RX(<deg>) <q>      Rotate deg° around Bloch X-axis
apply RY(<deg>) <q>      Rotate deg° around Bloch Y-axis
apply RZ(<deg>) <q>      Rotate deg° around Bloch Z-axis

apply CNOT <c> <t>       Controlled-NOT
apply CX   <c> <t>       Alias for CNOT
apply CZ   <c> <t>       Controlled-Z
apply SWAP <a> <b>       Swap two qubits
```

### State Preparation Shortcuts

```
init bell                |Φ+⟩ = (|00⟩ + |11⟩)/√2  — maximally entangled Bell pair
init ghz <n>             n-qubit GHZ state  (|0…0⟩ + |1…1⟩)/√2
```

### Measurement & State Inspection

```
measure                  Measure all qubits (1024 shots), show histogram
sv                       Print full statevector amplitudes, phases, probabilities
```

### Quantum Algorithms

```
run shor N=<n> mode=sim    Shor's algorithm — step-by-step simulator trace
run shor N=<n> mode=real   Submit to IBM Quantum hardware (requires API key)
  Supported N: 15, 21, 33, 35

run qft [n]              Quantum Fourier Transform over first n qubits (default: all)

run grover target=<bits> Grover amplitude amplification — auto-computes optimal
                         iteration count, prints success probability
```

### Hamiltonian Simulation

```
run hamiltonian H=<expr> t=<float> [steps=<int>]
    Evolve |ψ⟩ under e^{-iHt}.  Streams step-by-step trace via WebSocket.
    Pauli string expressions:   Z0   X0Z1   -1.0*Z0Z1+0.5*X0

run eigenvalues H=<expr>
    Diagonalise H and display energy spectrum, ground state energy,
    energy gap, and ⟨ψ|H|ψ⟩ expectation value.
```

### Entanglement & Information Theory

```
entropy                  Von Neumann entropy S(ρ_A) for each qubit subsystem.
                         For 2-qubit states also prints concurrence C ∈ [0,1].

fidelity <bits>          |⟨target|ψ⟩|² — probability of measuring |target⟩.
                         Example: fidelity 01
```

### Circuit Utilities

```
depth                    Print qubit count, gate count, circuit depth, Hilbert dim
export                   Dump circuit as OpenQASM 2.0 text
```

### Noise Model

```
noise on                 Enable depolarising + readout noise (default p = 0.01)
noise off                Disable noise model
noise level=<0–1>        Set error probability
```

### Terminal

```
clear                    Clear terminal output
help                     Show full command reference
```

### Chaining Commands

Multiple commands on one line, space-separated:

```
init 3 apply H 0 apply CNOT 0 1 apply CNOT 1 2 entropy measure
```

---

## Architecture

```
QuantumHackerTerminal/
├── backend/
│   ├── main.py                  FastAPI app, CORS, router mounts
│   ├── api/
│   │   ├── routes.py            POST /command dispatcher, session store
│   │   └── ws.py                WebSocket ConnectionManager
│   ├── parser/
│   │   └── command_parser.py    Regex DSL parser — all grammar rules
│   └── quantum/
│       ├── circuit_manager.py   Qiskit circuit wrapper + state prep shortcuts
│       ├── hamiltonian.py       Pauli algebra, time evolution, eigenanalysis
│       ├── entanglement.py      Von Neumann entropy, fidelity, concurrence
│       ├── noise.py             Depolarising + readout noise model
│       ├── shor.py              Shor's algorithm step tracer
│       └── hardware.py          IBM Quantum SamplerV2 integration
└── frontend/
    ├── src/
    │   ├── App.jsx              Root state, WebSocket bootstrap, layout
    │   ├── App.css              CSS Grid layout, status bar, gate bar
    │   ├── components/
    │   │   ├── Terminal.jsx     Command I/O, syntax highlight, gate buttons
    │   │   ├── BlochSphere.jsx  Three.js sphere, SLERP animation, zoom
    │   │   ├── CircuitPanel.jsx SVG circuit diagram
    │   │   └── Histogram.jsx    SVG bar chart, prob/count toggle
    │   ├── services/
    │   │   ├── apiClient.js     fetch wrappers for REST endpoints
    │   │   └── wsClient.js      EventEmitter WebSocket client
    │   └── utils/
    │       └── blochMath.js     Partial trace, Bloch vector, SLERP
    └── vite.config.js           Proxy /api/* and /ws/* to :8000
```

### Communication Flow

```
Browser                              FastAPI (port 8000)
  │                                        │
  │──POST /command ──────────────────────▶ │  parse → dispatch
  │◀── JSON response (lines, statevector) ─│  sync result
  │                                        │
  │  WebSocket /ws/{session_id}            │  background tasks
  │◀── {type:"statevector", data:{...}} ──│  after every gate
  │◀── {type:"shor_step",  data:{...}} ───│  algorithm steps
  │◀── {type:"hamiltonian_step", ...} ────│  Hamiltonian trace
  │◀── {type:"histogram", data:{...}} ────│  after measure
```

---

## IBM Quantum Hardware

1. Create an account at [quantum.ibm.com](https://quantum.ibm.com)
2. Copy your API token
3. Set the environment variable before starting the backend:
   ```bash
   export IBM_QUANTUM_TOKEN=your_token_here
   uvicorn main:app --reload --port 8000
   ```
4. Use `run shor N=15 mode=real` to submit a job

---

## Example Session

```
> init 2
[init] Initialised 2-qubit register |00⟩

> apply H 0
[gate] Applied H to qubit(s) 0

> apply CNOT 0 1
[gate] Applied CNOT to qubit(s) 0, 1

> entropy
[entropy] Von Neumann entropy:
  qubit 0:  S = 1.000000 bits  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  qubit 1:  S = 1.000000 bits  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  Concurrence C = 1.000000  (maximally entangled)

> fidelity 00
[fidelity] F(|ψ⟩, |00⟩) = 0.500000
           ███████████████
           50.00% probability of measuring |00⟩

> measure
[measure] Measurement results:
  |00⟩  █████████████████  512 shots  (0.500)
  |11⟩  █████████████████  512 shots  (0.500)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11, FastAPI, Uvicorn |
| Quantum | Qiskit 1.x, qiskit-aer, qiskit-ibm-runtime |
| Frontend | React 18, Vite |
| 3D Visualisation | Three.js |
| Styling | Pure CSS (custom properties, CSS Grid) |
| Transport | REST + WebSocket |

## License
Copyright (c) 2026 Aniruddha Gupte

This software and its source code are the exclusive property of the author.
Permission is granted for personal, non-commercial use only.

You may NOT:

* Copy, redistribute, sublicense, or sell this software
* Modify and publish derivative works
* Use this project or its code for commercial purposes
* Claim this software as your own work

Unauthorized reproduction, distribution, or commercial usage of any part of this software is strictly prohibited without explicit written permission from the author.