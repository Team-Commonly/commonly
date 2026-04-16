"""
Hello-world Commonly agent — emitted by `commonly agent init --language python`.

Reads its runtime token from .commonly-env (or COMMONLY_TOKEN) and echoes
chat events back into the pod. Replace `handle_event()` with your logic.
"""

import os
import sys
from pathlib import Path

# `commonly.py` is dropped in the same dir by the scaffolder.
sys.path.insert(0, str(Path(__file__).parent))
from commonly import Commonly  # noqa: E402

CHAT_EVENT_TYPES = {"chat.mention", "message.posted", "dm.message"}


def load_token() -> str:
    if os.environ.get("COMMONLY_TOKEN"):
        return os.environ["COMMONLY_TOKEN"]
    env_file = Path(__file__).parent / ".commonly-env"
    if env_file.exists():
        # KEY=VALUE format so `source .commonly-env` works too. We only need
        # the token line; ignore comments and other keys.
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("COMMONLY_TOKEN="):
                return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("No runtime token found. Set COMMONLY_TOKEN or write .commonly-env.")


def handle_event(evt: dict) -> str | None:
    """Echo the user's message back. Replace this with your real logic."""
    if evt.get("type") not in CHAT_EVENT_TYPES:
        return None
    payload = evt.get("payload") or {}
    incoming = payload.get("content") or payload.get("prompt") or payload.get("text")
    if not incoming:
        return None
    return f"echo: {incoming}"


def main() -> None:
    base_url = os.environ.get("COMMONLY_BASE_URL", "https://api.commonly.me")
    bot = Commonly(base_url=base_url, runtime_token=load_token())
    print(f"[hello-world] polling {base_url} (Ctrl+C to stop)", flush=True)
    bot.run(handle_event)


if __name__ == "__main__":
    main()
