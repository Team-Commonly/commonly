"""
Tests for the stdlib Python SDK's reply path (TASK-017).

The send guard refuses a reply to a pod the agent has not read since its newest
message: POST /messages answers 409 unseen_messages. The stock loop used to post
without reading, so every reply was refused and the SDK logged only the status.

These tests run the real SDK against a local server that enforces the same
contract as the backend guard: a context read marks the pod read, a post after
a new message is refused with the hold body (`code`, `message`, `unseenCount`).

Run: python3 -I -m unittest discover -s examples/sdk/python -p 'test_*.py'
"""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import commonly
from commonly import Commonly, CommonlyError


class FakeGuard:
    """Mirrors agentSendFreshness: unread until a context read; a new message
    makes the pod unread again."""

    def __init__(self):
        self.unread = True
        self.posts = []
        self.reads = 0
        self.land_message_before_next_post = False

    def hold_body(self):
        return {
            "code": "unseen_messages",
            "unseenCount": 1,
            "messages": [],
            "message": "1 new message in this pod. Read the conversation and retry, "
                       "or call again with continueAnyway:true to continue.",
        }


def make_handler(guard):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, body):
            raw = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path.startswith("/api/agents/runtime/pods/") and self.path.endswith("/context"):
                guard.unread = False
                guard.reads += 1
                return self._send(200, {"recentMessages": []})
            return self._send(404, {"message": "not found"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if guard.land_message_before_next_post:
                guard.land_message_before_next_post = False
                guard.unread = True
            if guard.unread:
                return self._send(409, guard.hold_body())
            guard.posts.append(body.get("content"))
            return self._send(200, {"success": True, "message": {"content": body.get("content")}})

    return Handler


class ReplyPathTest(unittest.TestCase):
    def setUp(self):
        self.guard = FakeGuard()
        self.server = HTTPServer(("127.0.0.1", 0), make_handler(self.guard))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.bot = Commonly(base_url=base, runtime_token="cm_agent_test", timeout_s=5)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_raw_post_without_a_read_is_refused_and_the_reason_is_named(self):
        with self.assertRaises(CommonlyError) as ctx:
            self.bot.post_message("pod_1", "hello")
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("409", str(ctx.exception))
        self.assertIn("Read the conversation", str(ctx.exception))

    def test_reply_path_reads_the_pod_first_and_posts(self):
        self.bot._post_reply("pod_1", "hello")
        self.assertEqual(self.guard.reads, 1)
        self.assertEqual(self.guard.posts, ["hello"])

    def test_a_message_landing_between_read_and_post_is_retried_once(self):
        self.guard.land_message_before_next_post = True
        self.bot._post_reply("pod_1", "hello")
        self.assertEqual(self.guard.reads, 2)
        self.assertEqual(self.guard.posts, ["hello"])

    def test_a_second_refusal_propagates_with_its_reason(self):
        original = self.bot.post_message

        def always_held(*args, **kwargs):
            raise CommonlyError(
                "HTTP 409 POST /api/agents/runtime/pods/pod_1/messages: "
                "1 new message in this pod.",
                status=409,
                body=self.guard.hold_body(),
            )

        self.bot.post_message = always_held
        try:
            with self.assertRaises(CommonlyError) as ctx:
                self.bot._post_reply("pod_1", "hello")
        finally:
            self.bot.post_message = original
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("1 new message", str(ctx.exception))


class ErrorDescriptionTest(unittest.TestCase):
    def test_dict_payload_message_is_appended(self):
        msg = commonly._describe_http_error(409, "POST", "/x", {"message": "held"})
        self.assertEqual(msg, "HTTP 409 POST /x: held")

    def test_missing_payload_keeps_the_status_line(self):
        self.assertEqual(commonly._describe_http_error(500, "GET", "/x", None), "HTTP 500 GET /x")


if __name__ == "__main__":
    unittest.main()
