#!/usr/bin/env python3
"""Template: live artifact runner that writes the *correct* artifact JSON envelope.

Why this exists
- A common failure mode is writing ONLY the payload (e.g. {"lines": [...]}) into
  ~/.hermes/artifacts/session/{tab_id}.json.
- hermelinChat expects the full artifact envelope: id, type, title, data, live,
  refresh_seconds, timestamp.

How to use
- Call create_artifact() once to create the tab (type/title/tab_id/live/refresh_seconds).
- Then call start_runner(tab_id=..., runner_code=THIS_FILE_CONTENT) to start updates.

Environment (set by start_runner)
- HERMES_ARTIFACT_TAB_ID
- HERMES_ARTIFACTS_HOME
- HERMES_ARTIFACT_PROJECT_DIR   (safe cwd)

This template updates a "logs" artifact.
"""

from __future__ import annotations

import json
import os
import signal
import time
from pathlib import Path


TAB_ID = (os.getenv("HERMES_ARTIFACT_TAB_ID") or "demo_logs").strip() or "demo_logs"
ARTIFACTS_HOME = Path(os.getenv("HERMES_ARTIFACTS_HOME") or "~/.hermes/artifacts").expanduser().resolve()

# Write to session scope by default; change to persistent/ if you created a persistent artifact.
OUT_PATH = ARTIFACTS_HOME / "session" / f"{TAB_ID}.json"

# The runner tool puts us in a safe project directory already, but keep it explicit.
PROJECT_DIR = Path(os.getenv("HERMES_ARTIFACT_PROJECT_DIR") or ".").expanduser().resolve()
PROJECT_DIR.mkdir(parents=True, exist_ok=True)

_stop = False


def _on_sigterm(_signum, _frame):
    global _stop
    _stop = True


signal.signal(signal.SIGTERM, _on_sigterm)


def _write_artifact(lines: list[dict]) -> None:
    """Write the FULL artifact envelope (not just payload)."""

    artifact = {
        "id": TAB_ID,
        "type": "logs",
        "title": f"Live logs: {TAB_ID}",
        "data": {
            "lines": lines,
        },
        "live": True,
        "refresh_seconds": 2,
        "timestamp": time.time(),
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    i = 0
    while not _stop:
        now = time.time()
        i += 1
        lines = [
            {"ts": now, "level": "info", "source": "runner", "msg": f"tick {i}"},
        ]
        _write_artifact(lines)
        time.sleep(2.0)
