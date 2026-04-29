import asyncio
import unittest

from hermelin.ws_writer import WebSocketPriorityWriter


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send_bytes(self, payload: bytes):
        self.sent.append(("bytes", payload))

    async def send_text(self, payload: str):
        self.sent.append(("text", payload))


class FailingWebSocket:
    async def send_bytes(self, payload: bytes):
        raise RuntimeError("send failed")

    async def send_text(self, payload: str):
        raise RuntimeError("send failed")


class SlowFailingWebSocket:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def send_bytes(self, payload: bytes):
        self.entered.set()
        await self.release.wait()
        raise RuntimeError("send failed")

    async def send_text(self, payload: str):
        self.entered.set()
        await self.release.wait()
        raise RuntimeError("send failed")


class WebSocketPriorityWriterTests(unittest.TestCase):
    def test_terminal_bytes_are_sent_before_older_artifact_payloads(self):
        async def scenario():
            ws = FakeWebSocket()
            writer = WebSocketPriorityWriter(ws)

            self.assertTrue(await writer.send_text("artifact", priority=20, droppable=True))
            await writer.send_bytes(b"pty")
            await writer.stop()
            await writer.run()

            self.assertEqual(ws.sent, [("bytes", b"pty"), ("text", "artifact")])

        asyncio.run(scenario())

    def test_droppable_artifacts_are_skipped_when_backlog_is_high(self):
        async def scenario():
            ws = FakeWebSocket()
            writer = WebSocketPriorityWriter(ws, max_droppable_backlog=1)

            self.assertTrue(await writer.send_text("artifact-1", priority=20, droppable=True))
            self.assertFalse(await writer.send_text("artifact-2", priority=20, droppable=True))
            await writer.send_bytes(b"pty")
            await writer.stop()
            await writer.run()

            self.assertEqual(ws.sent, [("bytes", b"pty"), ("text", "artifact-1")])

        asyncio.run(scenario())

    def test_terminal_bytes_are_backpressured_when_queue_is_full(self):
        async def scenario():
            ws = FakeWebSocket()
            writer = WebSocketPriorityWriter(ws, max_pending_bytes=4)

            self.assertTrue(await writer.send_bytes(b"1234"))
            blocked = asyncio.create_task(writer.send_bytes(b"56"))
            await asyncio.sleep(0)
            self.assertFalse(blocked.done())

            runner = asyncio.create_task(writer.run())
            self.assertTrue(await asyncio.wait_for(blocked, timeout=1.0))
            await writer.stop()
            await runner

            self.assertEqual(ws.sent, [("bytes", b"1234"), ("bytes", b"56")])

        asyncio.run(scenario())

    def test_send_failure_stops_writer_and_wakes_future_producers(self):
        async def scenario():
            writer = WebSocketPriorityWriter(FailingWebSocket(), max_pending_bytes=4)

            self.assertTrue(await writer.send_bytes(b"1234"))
            with self.assertRaises(RuntimeError):
                await writer.run()

            self.assertFalse(await writer.send_bytes(b"later"))
            self.assertFalse(await writer.send_text("artifact", droppable=True))

        asyncio.run(scenario())

    def test_send_failure_clears_messages_enqueued_during_inflight_send(self):
        async def scenario():
            ws = SlowFailingWebSocket()
            writer = WebSocketPriorityWriter(ws, max_pending_bytes=4)

            self.assertTrue(await writer.send_bytes(b"1234"))
            blocked = asyncio.create_task(writer.send_bytes(b"56"))
            await asyncio.sleep(0)
            self.assertFalse(blocked.done())

            runner = asyncio.create_task(writer.run())
            await asyncio.wait_for(ws.entered.wait(), timeout=1.0)
            self.assertTrue(await asyncio.wait_for(blocked, timeout=1.0))
            self.assertEqual(writer.backlog, 1)

            ws.release.set()
            with self.assertRaises(RuntimeError):
                await runner

            self.assertEqual(writer.backlog, 0)
            self.assertEqual(writer.pending_bytes, 0)
            self.assertEqual(writer.droppable_backlog, 0)
            self.assertFalse(await writer.send_bytes(b"later"))

        asyncio.run(scenario())

    def test_oversized_messages_are_refused_even_when_queue_is_empty(self):
        async def scenario():
            writer = WebSocketPriorityWriter(FakeWebSocket(), max_pending_bytes=4, max_single_message_bytes=8)

            self.assertFalse(await writer.send_text("x" * 9, droppable=True))
            self.assertFalse(await writer.send_bytes(b"123456789"))
            self.assertEqual(writer.backlog, 0)
            self.assertEqual(writer.pending_bytes, 0)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
