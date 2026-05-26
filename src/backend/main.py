"""
Quantum Hacker Terminal — FastAPI entry point.

Boots the ASGI application, wires up CORS so the Vite dev server can talk to
us freely, then mounts the REST router and the WebSocket router.  Everything
session-specific (circuit state, noise config, job handles) lives inside the
routers; this file stays deliberately thin.
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()                           # pull IBM_QUANTUM_TOKEN (and anything else) from .env

from api.routes import router           # REST endpoints  (/session/new, /command, /snapshot/*)
from api.ws import ws_router            # WebSocket endpoint  (/ws/{session_id})


# ---------------------------------------------------------------------------
# Lifespan — place any startup / teardown work here (DB pools, caches, etc.)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # nothing to warm up at the moment; yield hands control to the server
    yield
    # graceful teardown would go here (e.g. cancel pending hardware jobs)


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Quantum Hacker Terminal",
    description="Browser-based quantum computing simulation environment.",
    version="1.0.0",
    lifespan=lifespan,
)

# Allow the React dev server (port 5173) and any production origin you add later
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(ws_router)


# ---------------------------------------------------------------------------
# Quick health-check — useful for Docker / CI probes
# ---------------------------------------------------------------------------
@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok"}
