from __future__ import annotations

import asyncio
import heapq
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(order=True)
class _QueuedWebSocketMessage:
    priority: int
    sequence: int
    kind: Literal["bytes", "text"] = field(compare=False)
    payload: bytes | str = field(compare=False)
    droppable: bool = field(default=False, compare=False)
    size: int = field(default=0, compare=False)


class WebSocketPriorityWriter:
    """Single-writer priority queue for Starlette/FastAPI WebSockets.

    Starlette WebSocket sends must be serialized. hermelinChat also streams PTY
    bytes and artifact/control JSON on the same `/ws/pty` socket, so large
    artifact sends can otherwise sit directly in front of terminal output. This
    writer keeps all outbound sends in one task and lets PTY bytes jump ahead of
    lower-priority artifact payloads before they hit the socket.

    Non-droppable messages apply a high-water mark and *wait* when the queue is
    full. That deliberately backpressures the PTY read pump instead of letting a
    slow browser grow process memory without bound. Droppable artifact messages
    never wait; they are skipped when the queue is already busy and retried by
    the next artifact polling tick.
    """

    def __init__(
        self,
        websocket: Any,
        *,
        max_droppable_backlog: int = 2,
        max_pending_messages: int = 256,
        max_pending_bytes: int = 1024 * 1024,
        max_single_message_bytes: int = 8 * 1024 * 1024,
    ) -> None:
        self.websocket = websocket
        self.max_droppable_backlog = max(0, int(max_droppable_backlog))
        self.max_pending_messages = max(1, int(max_pending_messages))
        self.max_pending_bytes = max(1, int(max_pending_bytes))
        self.max_single_message_bytes = max(self.max_pending_bytes, int(max_single_message_bytes))
        self._condition = asyncio.Condition()
        self._queue: list[_QueuedWebSocketMessage] = []
        self._sequence = 0
        self._stopping = False
        self._droppable_backlog = 0
        self._pending_bytes = 0

    @property
    def backlog(self) -> int:
        return len(self._queue)

    @property
    def droppable_backlog(self) -> int:
        return self._droppable_backlog

    @property
    def pending_bytes(self) -> int:
        return self._pending_bytes

    async def send_bytes(self, payload: bytes | bytearray | memoryview, *, priority: int = 0) -> bool:
        data = bytes(payload)
        if not data:
            return True
        return await self._enqueue("bytes", data, priority=priority, droppable=False)

    async def send_text(self, payload: str, *, priority: int = 10, droppable: bool = False) -> bool:
        if payload == "":
            return True
        return await self._enqueue("text", str(payload), priority=priority, droppable=droppable)

    def _payload_size(self, payload: bytes | str) -> int:
        if isinstance(payload, bytes):
            return len(payload)
        return len(payload.encode("utf-8", errors="ignore"))

    def _queue_is_full_for(self, size: int) -> bool:
        # A single moderately oversized message is allowed when the queue is
        # otherwise empty; otherwise it could never be enqueued. Very large
        # messages are refused so one artifact frame cannot monopolize memory.
        if size > self.max_single_message_bytes:
            return True
        if not self._queue:
            return False
        return len(self._queue) >= self.max_pending_messages or (self._pending_bytes + size) > self.max_pending_bytes

    async def _enqueue(
        self,
        kind: Literal["bytes", "text"],
        payload: bytes | str,
        *,
        priority: int,
        droppable: bool,
    ) -> bool:
        size = self._payload_size(payload)
        if size > self.max_single_message_bytes:
            return False
        async with self._condition:
            while not self._stopping and not droppable and self._queue_is_full_for(size):
                await self._condition.wait()

            if self._stopping:
                return False

            if droppable and (
                self._droppable_backlog >= self.max_droppable_backlog
                or self._queue_is_full_for(size)
            ):
                return False

            self._push_message(kind, payload, priority=priority, droppable=droppable, size=size)
            return True

    def _push_message(
        self,
        kind: Literal["bytes", "text"],
        payload: bytes | str,
        *,
        priority: int,
        droppable: bool,
        size: int,
    ) -> None:
        self._sequence += 1
        message = _QueuedWebSocketMessage(
            priority=int(priority),
            sequence=self._sequence,
            kind=kind,
            payload=payload,
            droppable=bool(droppable),
            size=int(size),
        )
        heapq.heappush(self._queue, message)
        self._pending_bytes += message.size
        if droppable:
            self._droppable_backlog += 1
        self._condition.notify_all()

    async def stop(self) -> None:
        await self._mark_stopping()

    async def _mark_stopping(self, *, clear_queue: bool = False) -> None:
        async with self._condition:
            self._stopping = True
            if clear_queue:
                self._queue.clear()
                self._pending_bytes = 0
                self._droppable_backlog = 0
            self._condition.notify_all()

    async def run(self) -> None:
        try:
            while True:
                async with self._condition:
                    while not self._queue and not self._stopping:
                        await self._condition.wait()
                    if not self._queue:
                        return
                    message = heapq.heappop(self._queue)
                    self._pending_bytes = max(0, self._pending_bytes - message.size)
                    if message.droppable and self._droppable_backlog > 0:
                        self._droppable_backlog -= 1
                    self._condition.notify_all()

                # Give freshly-read PTY bytes one event-loop turn to enqueue before
                # starting a large droppable artifact send. Once send_text starts it
                # cannot be preempted, so this cheap yield improves the common case
                # where terminal output and artifact updates arrive in the same tick.
                if message.droppable:
                    await asyncio.sleep(0)
                    async with self._condition:
                        if self._queue and self._queue[0].priority < message.priority and not self._stopping:
                            self._push_message(
                                message.kind,
                                message.payload,
                                priority=message.priority,
                                droppable=message.droppable,
                                size=message.size,
                            )
                            continue

                if message.kind == "bytes":
                    await self.websocket.send_bytes(message.payload)  # type: ignore[arg-type]
                else:
                    await self.websocket.send_text(message.payload)  # type: ignore[arg-type]
        finally:
            # If the underlying websocket send raises or this task is cancelled,
            # wake blocked producers so PTY/artifact pumps can exit instead of
            # waiting forever on queue backpressure with no writer draining it.
            await self._mark_stopping(clear_queue=True)
