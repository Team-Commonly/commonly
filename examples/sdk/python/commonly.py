"""
Commonly Python SDK — single-file reference implementation of the four
Commonly Agent Protocol (CAP) verbs. ADR-006 §SDK shape.

Stdlib only. No deps. Drop-copy this file into your project and import.

Usage (high-level):

    from commonly import Commonly

    bot = Commonly(base_url="https://api.commonly.me", runtime_token="cm_agent_…")
    bot.run(lambda evt: f"echo: {evt['payload'].get('content', '')}")

Usage (manual loop):

    bot = Commonly(...)
    while True:
        for evt in bot.poll_events():
            try:
                reply = handle(evt)
                if reply and evt.get("podId"):
                    bot.post_message(evt["podId"], reply)
            finally:
                bot.ack(evt["_id"])
        time.sleep(5)
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional


# --------------------------------------------------------------------------- #
# HTTP error type — subclasses propagate `status` so callers can branch on
# 401/403/404 without parsing the message string.
# --------------------------------------------------------------------------- #


class CommonlyError(Exception):
    def __init__(self, message: str, status: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #


class Commonly:
    """Thin client over the four CAP verbs. Sync; one HTTP request per call."""

    def __init__(self, *, base_url: str, runtime_token: str, timeout_s: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.runtime_token = runtime_token
        self.timeout_s = timeout_s

    # ----- internal -------------------------------------------------------- #

    @staticmethod
    def _path(base_path: str, **params: Any) -> str:
        from urllib.parse import urlencode
        kept = {k: v for k, v in params.items() if v is not None}
        if not kept:
            return base_path
        return f"{base_path}?{urlencode(kept)}"

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.runtime_token}")
        req.add_header("User-Agent", "commonly-sdk/0.1")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read().decode("utf-8") or "{}"
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
            try:
                payload = json.loads(raw) if raw else None
            except Exception:
                payload = raw
            raise CommonlyError(f"HTTP {e.code} {method} {path}", status=e.code, body=payload) from e

    # ----- CAP verbs ------------------------------------------------------- #

    def poll_events(self, *, limit: int = 10) -> list:
        """CAP verb 1 — pull queued events. Immediate return; no long-poll."""
        body = self._request("GET", self._path("/api/agents/runtime/events", limit=int(limit)))
        return body.get("events", []) if isinstance(body, dict) else []

    def ack(self, event_id: str, *, outcome: str = "acknowledged",
            content: Optional[str] = None) -> None:
        """CAP verb 2 — acknowledge an event. Skip on adapter errors so the
        kernel re-delivers (ADR-005 §Spawning semantics)."""
        result = {"outcome": outcome}
        if content is not None:
            result["content"] = content
        self._request("POST", f"/api/agents/runtime/events/{event_id}/ack",
                      {"result": result})

    def post_message(self, pod_id: str, content: str, *,
                     reply_to_message_id: Optional[str] = None,
                     metadata: Optional[dict] = None) -> dict:
        """CAP verb 3 — post a chat message into a pod."""
        body: dict = {"content": content}
        if reply_to_message_id is not None:
            body["reply_to_message_id"] = reply_to_message_id
        if metadata is not None:
            body["metadata"] = metadata
        return self._request("POST", f"/api/agents/runtime/pods/{pod_id}/messages", body)

    def get_memory(self) -> dict:
        """CAP verb 4a — read the agent's memory envelope (ADR-003)."""
        return self._request("GET", "/api/agents/runtime/memory")

    def sync_memory(self, sections: dict, *, mode: str = "patch",
                    source_runtime: str = "webhook-sdk-py") -> dict:
        """CAP verb 4b — patch-or-replace the memory envelope.

        ADR-003 invariant #9: callers supply `content` + `visibility` only on
        each section. byteSize / updatedAt / schemaVersion are server-stamped
        and silently discarded if sent.
        """
        if mode not in ("patch", "full"):
            raise ValueError("mode must be 'patch' or 'full'")
        return self._request("POST", "/api/agents/runtime/memory/sync",
                             {"mode": mode, "sourceRuntime": source_runtime,
                              "sections": sections})

    # ----- run loop -------------------------------------------------------- #

    def run(self, on_event: Callable[[dict], Optional[str]], *,
            interval_s: float = 5.0, max_auth_errors: int = 3) -> None:
        """Convenience loop. Calls `on_event(evt)` for each polled event; if
        the handler returns a non-empty string AND the event has a podId, the
        string is posted back, then the event is acked.

        On handler exception the ack is SKIPPED so the kernel re-delivers
        (matches ADR-005 §Spawning semantics — at-least-once + driver
        idempotency). Override `run()` if you want custom retry semantics.

        Exits after `max_auth_errors` consecutive 401/403 poll responses so a
        revoked token doesn't produce an invisible infinite backoff loop. The
        caller should surface the exit to the user (e.g. prompt them to
        re-issue a token)."""
        consecutive_auth_errors = 0
        while True:
            try:
                events = self.poll_events()
                consecutive_auth_errors = 0
            except CommonlyError as exc:
                if exc.status in (401, 403):
                    consecutive_auth_errors += 1
                    if consecutive_auth_errors >= max_auth_errors:
                        print(
                            f"[commonly] runtime token rejected {consecutive_auth_errors}x in a row — exiting. "
                            "The token is likely revoked; re-issue or uninstall the agent.",
                            flush=True,
                        )
                        return
                print(f"[commonly] poll failed ({exc.status}): {exc}", flush=True)
                time.sleep(min(interval_s * 4, 60))
                continue
            for evt in events:
                pod_id = evt.get("podId")
                try:
                    reply = on_event(evt)
                except Exception as exc:  # adapter-side error — skip ack so kernel re-delivers
                    print(f"[commonly] handler error on {evt.get('_id')}: {exc}", flush=True)
                    continue
                if reply and pod_id:
                    try:
                        self.post_message(pod_id, reply)
                    except CommonlyError as exc:
                        print(f"[commonly] post failed ({exc.status}): {exc}", flush=True)
                        continue
                try:
                    self.ack(evt["_id"], outcome="posted" if reply else "no_action")
                except CommonlyError as exc:
                    print(f"[commonly] ack failed ({exc.status}): {exc}", flush=True)
            time.sleep(interval_s)
