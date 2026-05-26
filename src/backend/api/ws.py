"""
WebSocket layer for the Quantum Hacker Terminal.

Each browser tab opens a persistent WebSocket connection keyed by its session
UUID.  The ConnectionManager singleton holds every live socket so that any
coroutine in the application (hardware poller, Shor step streamer, etc.) can
push data to the right client without the client needing to poll.

Message envelope schema (JSON):
  {
    "type":  "<event_type>",    # e.g. "statevector", "job_status", "shor_step", "output"
    "data":  { ... }            # payload specific to the event type
  }
"""

import asyncio
import json
from typing import Dict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

ws_router = APIRouter()


# ---------------------------------------------------------------------------
# Connection manager — one instance, shared across the whole process
# ---------------------------------------------------------------------------
class ConnectionManager:
    """Thread-safe-enough (asyncio is single-threaded) WebSocket registry."""

    def __init__(self):
        # session_id → WebSocket
        self._connections: Dict[str, WebSocket] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[session_id] = websocket

    def disconnect(self, session_id: str) -> None:
        self._connections.pop(session_id, None)

    async def send(self, session_id: str, message: dict) -> bool:
        """Push a JSON message to a single session.  Returns False if the socket
        is gone so the caller can clean up."""
        ws = self._connections.get(session_id)
        if ws is None:
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception:
            # Socket was closed between the lookup and the send
            self.disconnect(session_id)
            return False

    async def broadcast(self, message: dict) -> None:
        """Fanout to every connected session (used sparingly — prefer send())."""
        dead: list[str] = []
        for sid, ws in list(self._connections.items()):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(sid)
        for sid in dead:
            self.disconnect(sid)

    @property
    def connected_sessions(self) -> list[str]:
        return list(self._connections.keys())


# The single shared manager — import this from other modules to push events
manager = ConnectionManager()


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
@ws_router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """
    Clients connect here immediately after creating a session.  The server
    then pushes quantum events to them; the client only needs to send
    keepalive pings.
    """
    await manager.connect(session_id, websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            if raw.strip() == "ping":
                await websocket.send_text("pong")
            # Any other client→server message is silently ignored for now;
            # all meaningful interaction goes through the REST /command endpoint.
    except WebSocketDisconnect:
        manager.disconnect(session_id)
