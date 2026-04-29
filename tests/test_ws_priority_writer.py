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


if __name__ == "__main__":
    unittest.main()
