"""Select CI suites from the actual PR or merge-group diff.

Unknown paths and diff failures run every suite. A missing check must never
turn into a green required gate.
"""

import os
import subprocess
from pathlib import Path


SUITES = ("backend", "frontend", "tools", "chart")


def select(paths):
    selected = {suite: False for suite in SUITES}
    if not paths:
        return {suite: True for suite in SUITES}

    for path in paths:
        if path == "docs/runbooks/alerting.md":
            selected["chart"] = True
            continue
        if path.startswith("docs/") or ("/" not in path and path.endswith(".md")):
            continue
        if path.startswith("backend/"):
            selected["backend"] = True
            # Frontend typecheck and catalogue tests import backend modules.
            selected["frontend"] = True
            selected["chart"] = True
        elif path.startswith("frontend/"):
            selected["frontend"] = True
        elif path.startswith(("cli/", "commonly-mcp/", "workers/agent-runtime/")):
            selected["tools"] = True
        elif path.startswith("k8s/"):
            selected["chart"] = True
        else:
            return {suite: True for suite in SUITES}
    return selected


def main():
    event = os.environ.get("EVENT_NAME")
    base = os.environ.get("BASE_SHA")
    head = os.environ.get("GITHUB_SHA")
    if event not in ("pull_request", "merge_group") or not base or not head:
        result = select([])
    else:
        try:
            changed = subprocess.check_output(
                ["git", "diff", "--name-only", "-z", base, head],
                stderr=subprocess.DEVNULL,
            ).decode().rstrip("\0").split("\0")
            result = select(changed)
        except (subprocess.CalledProcessError, UnicodeDecodeError):
            result = select([])

    output = Path(os.environ["GITHUB_OUTPUT"])
    with output.open("a") as stream:
        for suite, enabled in result.items():
            stream.write(f"{suite}={str(enabled).lower()}\n")


if __name__ == "__main__":
    main()
