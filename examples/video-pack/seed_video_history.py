#!/usr/bin/env python3
from __future__ import annotations

"""seed_video_history.py — Wipe + seed hermilinChat sidebar history for video demos.

This script operates ONLY on the Hermes HOME that hermilinChat uses.

It will:
- Back up $HERMES_HOME/state.db (+ state.db-wal/state.db-shm if present)
- Back up hermilinChat meta DB (titles): $HERMES_HOME/hermilin_meta.db by default
- DELETE all sessions + messages from state.db
- Insert 15–20 synthetic sessions spread across past days
- Upsert custom session titles into hermilin_meta.db/session_titles

Restore:
- Use --restore to restore the most recent backup.

Typical usage on the video machine:
  cd /path/to/hermilinChat
  ./.venv/bin/python examples/video-pack/seed_video_history.py --env-file .hermelin.env

Then restart hermilinChat.
"""

import argparse
import datetime as dt
import json
import os
import random
import shlex
import secrets
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Iterable


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent


DEFAULT_TITLES = [
    "Locate Teknium",
    "Create the White Rabbit",
    "Teknium Signal Intercept",
    "NVLink Cathedral",
    "InfiniBand Whisper Route",
    "Black ICE on the NVLink Fabric",
    "DGX Fabric Wake Sequence",
    "Rack 7 Cold Boot",
    "Kernel Panic in Neon Rain",
    "B300 Telemetry Mirage",
    "NCCL Handshake at Midnight",
    "Slurm Queue Prophecy",
    "Ghost Pods on the Compute Mesh",
    "The Swarm Wakes (Scheduler Online)",
    "Shadow Budget Allocation",
    "Strudel: Acid Bassline Protocol",
    "Strudel: Quantize the Chaos",
    "Modulate the Neon Choir",
    "Bitcrush the Simulation",
    "Sidechain the Sentinels",
    "Reverb in the Back Alley",
    "Timeline Splice in the Construct",
    "Keyframe the Nightmare",
    "Render Farm After Midnight",
    "Encode at Dawn",
    "CRT Bloom Calibration",
    "Glitch Pass: VHS Ghosting",
    "Neon Ledger Reconciliation",
    "Seed the Past (Video Patch)",
]


DEFAULT_WHISPERS = [
    "GPU",
    "BUILDER",
    "STRUDEL",
    "MONEY",
    "Locate Teknium",
    "Create the White Rabbit",
    "Show NVLink fabric map",
    "Run a telemetry sweep",
    "Rebuild the timeline",
    "Export the final deck",
    "Keep it cyberpunk. Keep it short.",
]


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"env file not found: {path}")

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        if not k:
            continue
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k] = v

    return out


def _default_hermes_home() -> Path:
    home = os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))
    return Path(home).expanduser()


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _ts_now_iso() -> str:
    return dt.datetime.now(tz=dt.timezone.utc).isoformat()


def _connect_sqlite(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def _read_titles_file(path: Path) -> list[str]:
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        lines.append(s)
    return lines


def _choose_backup_dir(backup_root: Path, backup_id: str | None) -> Path:
    if backup_id:
        return backup_root / backup_id

    if not backup_root.exists():
        raise FileNotFoundError(f"no backups found (missing dir): {backup_root}")

    dirs = [p for p in backup_root.iterdir() if p.is_dir()]
    dirs.sort(key=lambda p: p.name)
    if not dirs:
        raise FileNotFoundError(f"no backups found in: {backup_root}")

    return dirs[-1]


def _backup_files(*, backup_dir: Path, files: Iterable[Path], dry_run: bool) -> dict:
    _ensure_dir(backup_dir)

    copied: list[dict] = []
    for f in files:
        src = Path(f)
        if not src.exists():
            continue
        dst = backup_dir / src.name
        if dry_run:
            copied.append({"src": str(src), "dst": str(dst), "bytes": src.stat().st_size})
            continue
        shutil.copy2(src, dst)
        copied.append({"src": str(src), "dst": str(dst), "bytes": dst.stat().st_size})

    manifest = {
        "kind": "hermilinChat.video_history_backup",
        "created_at": _ts_now_iso(),
        "files": copied,
    }

    if not dry_run:
        (backup_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return manifest


def _restore_backup(*, backup_dir: Path, hermes_home: Path, meta_db_path: Path, dry_run: bool) -> None:
    # By convention we store backups by basename.
    restore_map = {
        "state.db": hermes_home / "state.db",
        "state.db-wal": hermes_home / "state.db-wal",
        "state.db-shm": hermes_home / "state.db-shm",
        meta_db_path.name: meta_db_path,
        "hermilin_meta.db": meta_db_path,  # also handle default name
    }

    print(f"Restoring from: {backup_dir}")

    restored_any = False
    for name, target in restore_map.items():
        src = backup_dir / name
        if not src.exists():
            continue
        restored_any = True
        print(f"  restore {src.name} -> {target}")
        if dry_run:
            continue
        _ensure_dir(target.parent)
        shutil.copy2(src, target)

    if not restored_any:
        raise FileNotFoundError(f"backup dir did not contain expected files: {backup_dir}")

    print("Restore complete.")


def _ensure_meta_db_schema(meta_db_path: Path) -> None:
    _ensure_dir(meta_db_path.parent)
    with _connect_sqlite(meta_db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_titles (
                session_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'auto',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_session_titles_source ON session_titles(source);")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ui_whispers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'auto',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                used_count INTEGER NOT NULL DEFAULT 0,
                last_used_at REAL
            );
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ui_whispers_source ON ui_whispers(source);")
        conn.commit()


def _seed_meta_db(*, meta_db_path: Path, titles: dict[str, str], seed_whispers: bool, dry_run: bool) -> None:
    _ensure_meta_db_schema(meta_db_path)

    if dry_run:
        print(f"[dry-run] would write session titles to: {meta_db_path}")
        if seed_whispers:
            print(f"[dry-run] would seed ui_whispers ({len(DEFAULT_WHISPERS)} rows)")
        return

    now = dt.datetime.now(tz=dt.timezone.utc).timestamp()

    with _connect_sqlite(meta_db_path) as conn:
        conn.execute("BEGIN")
        # Clear old titles (video machine = disposable; we always have a backup).
        conn.execute("DELETE FROM session_titles")

        for sid, title in titles.items():
            conn.execute(
                """
                INSERT INTO session_titles (session_id, title, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    title = excluded.title,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                """,
                (sid, title, "video-seed", now, now),
            )

        if seed_whispers:
            conn.execute("DELETE FROM ui_whispers WHERE source = 'video-seed'")
            for w in DEFAULT_WHISPERS:
                conn.execute(
                    """
                    INSERT INTO ui_whispers (text, source, created_at, updated_at, used_count, last_used_at)
                    VALUES (?, ?, ?, ?, 0, NULL)
                    """,
                    (w, "video-seed", now, now),
                )

        conn.commit()


def _infer_seed_model(db_path: Path) -> tuple[str | None, str | None, str | None]:
    """Try to use the last recorded session's model/system_prompt so seeded rows look consistent."""
    try:
        with _connect_sqlite(db_path) as conn:
            r = conn.execute(
                "SELECT model, model_config, system_prompt FROM sessions ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
            if not r:
                return None, None, None
            return (
                (r["model"] if r["model"] else None),
                (r["model_config"] if r["model_config"] else None),
                (r["system_prompt"] if r["system_prompt"] else None),
            )
    except Exception:
        return None, None, None


def _generate_session_times(*, count: int) -> list[float]:
    # We want: nothing in "Today" (in UI grouping). Seed mostly "Earlier", with a touch of "Yesterday".
    # Compute local start-of-today epoch.
    now_local = dt.datetime.now()
    start_of_today_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    rng = random.Random(0xB300)  # deterministic-ish, so re-runs are stable

    # Newest seeded session lands in "Yesterday" (some hours before local midnight).
    t = start_of_today_local - rng.uniform(60 * 45, 60 * 60 * 10)

    out: list[float] = []
    for _ in range(count):
        out.append(t)
        # Step backwards 10–30 hours each time => spans days naturally.
        t -= rng.uniform(60 * 60 * 10, 60 * 60 * 30)

    # Ensure strictly descending (newest first)
    out.sort(reverse=True)
    return out


def _session_id_for_ts(ts: float) -> str:
    dtu = dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)
    return f"{dtu.strftime('%Y%m%d_%H%M%S')}_{secrets.token_hex(3)}"


def _seed_state_db(*, db_path: Path, sessions: list[dict], dry_run: bool, vacuum: bool) -> None:
    if not db_path.exists():
        raise FileNotFoundError(f"state.db not found: {db_path} (run Hermes once to initialize)")

    if dry_run:
        print(f"[dry-run] would wipe + seed: {db_path}")
        print(f"[dry-run] sessions: {len(sessions)}")
        return

    with _connect_sqlite(db_path) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN")

        # Wipe messages first (FK -> sessions).
        conn.execute("DELETE FROM messages")
        conn.execute("DELETE FROM sessions")
        conn.execute("DELETE FROM sqlite_sequence WHERE name='messages'")
        conn.commit()

        conn.execute("BEGIN")
        # Insert sessions.
        for s in sessions:
            conn.execute(
                """
                INSERT INTO sessions (
                    id, source, user_id, model, model_config, system_prompt, parent_session_id,
                    started_at, ended_at, end_reason,
                    message_count, tool_call_count, input_tokens, output_tokens, title
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    s["id"],
                    s.get("source") or "cli",
                    s.get("user_id"),
                    s.get("model"),
                    s.get("model_config"),
                    s.get("system_prompt"),
                    s.get("parent_session_id"),
                    float(s["started_at"]),
                    float(s.get("ended_at")) if s.get("ended_at") is not None else None,
                    s.get("end_reason"),
                    int(s.get("message_count", 0)),
                    int(s.get("tool_call_count", 0)),
                    int(s.get("input_tokens", 0)),
                    int(s.get("output_tokens", 0)),
                    s.get("title"),
                ),
            )

        # Insert messages.
        for m in sessions:
            sid = m["id"]
            msgs = m.get("messages") or []
            for msg in msgs:
                conn.execute(
                    """
                    INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason)
                    VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)
                    """,
                    (sid, msg["role"], msg.get("content"), float(msg["timestamp"])),
                )

        # Ensure FTS is perfectly in sync.
        try:
            conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        except Exception:
            pass

        conn.commit()

        # Compact.
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass

        if vacuum:
            try:
                conn.execute("VACUUM")
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Wipe + seed hermilinChat history (state.db + hermilin_meta.db)")
    p.add_argument(
        "--env-file",
        default=str(REPO_ROOT / ".hermelin.env"),
        help="Path to .hermelin.env (default: ./.hermelin.env)",
    )
    p.add_argument(
        "--hermes-home",
        default="",
        help="Override Hermes HOME (otherwise uses HERMES_HOME from env-file, then $HERMES_HOME, then ~/.hermes)",
    )
    p.add_argument(
        "--meta-db",
        default="",
        help="Override hermilin meta DB path (otherwise uses HERMELIN_META_DB_PATH from env-file, else $HERMES_HOME/hermilin_meta.db)",
    )
    p.add_argument(
        "--count",
        type=int,
        default=len(DEFAULT_TITLES),
        help=f"How many synthetic sessions to create (default: {len(DEFAULT_TITLES)})",
    )
    p.add_argument(
        "--titles-file",
        default="",
        help="Optional plaintext file containing one title per line (blank lines and #comments ignored)",
    )
    p.add_argument(
        "--seed-whispers",
        action="store_true",
        help="Also seed ui_whispers in hermilin_meta.db (video-seed source)",
    )
    p.add_argument(
        "--no-vacuum",
        action="store_true",
        help="Skip VACUUM compaction",
    )
    p.add_argument(
        "--backup-id",
        default="",
        help="When restoring, choose a specific backup dir name (otherwise latest)",
    )
    p.add_argument(
        "--restore",
        action="store_true",
        help="Restore from the most recent backup and exit",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without modifying anything",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    env_path = Path(str(args.env_file)).expanduser()
    env = {}
    try:
        env = _parse_env_file(env_path)
    except FileNotFoundError:
        env = {}

    hermes_home_raw = str(args.hermes_home or env.get("HERMES_HOME") or os.getenv("HERMES_HOME") or _default_hermes_home())
    hermes_home = Path(hermes_home_raw).expanduser()

    meta_db_raw = str(args.meta_db or env.get("HERMELIN_META_DB_PATH") or os.getenv("HERMELIN_META_DB_PATH") or (hermes_home / "hermilin_meta.db"))
    meta_db_path = Path(meta_db_raw).expanduser()

    state_db_path = hermes_home / "state.db"

    backup_root = hermes_home / "backups" / "video-history"

    if args.restore:
        backup_dir = _choose_backup_dir(backup_root, args.backup_id.strip() or None)
        _restore_backup(backup_dir=backup_dir, hermes_home=hermes_home, meta_db_path=meta_db_path, dry_run=bool(args.dry_run))
        return 0

    # Titles
    titles = list(DEFAULT_TITLES)
    if args.titles_file:
        tfile = Path(str(args.titles_file)).expanduser()
        if not tfile.exists():
            print(f"ERROR: titles file not found: {tfile}", file=sys.stderr)
            return 2
        titles = _read_titles_file(tfile)

    count = int(args.count or 0)
    if count <= 0:
        print("ERROR: --count must be >= 1", file=sys.stderr)
        return 2

    if len(titles) < count:
        # If the operator requests more sessions than titles, we repeat with a suffix.
        base = list(titles)
        while len(titles) < count:
            n = len(titles) - len(base) + 2
            for t in base:
                titles.append(f"{t} ({n})")
                if len(titles) >= count:
                    break

    titles = titles[:count]

    # Backup
    backup_id = dt.datetime.now(tz=dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = backup_root / backup_id

    files_to_backup = [
        state_db_path,
        hermes_home / "state.db-wal",
        hermes_home / "state.db-shm",
        meta_db_path,
    ]

    print("Video history seed")
    print(f"  Hermes HOME: {hermes_home}")
    print(f"  state.db:    {state_db_path}")
    print(f"  meta db:     {meta_db_path}")
    print(f"  backup dir:  {backup_dir}")

    manifest = _backup_files(backup_dir=backup_dir, files=files_to_backup, dry_run=bool(args.dry_run))
    if args.dry_run:
        print(f"[dry-run] backup manifest: {json.dumps(manifest, indent=2)[:1200]}")

    # Seed sessions
    model, model_config, system_prompt = _infer_seed_model(state_db_path)

    times = _generate_session_times(count=len(titles))
    sessions: list[dict] = []
    for title, started_at in zip(titles, times, strict=True):
        sid = _session_id_for_ts(started_at)
        ended_at = started_at + random.uniform(60 * 2, 60 * 12)

        # Keep the transcript minimal but plausible.
        user_line = title

        t = title.lower()
        if any(
            k in t
            for k in [
                "nvlink",
                "infiniband",
                "dgx",
                "b300",
                "nccl",
                "slurm",
                "rack",
                "kernel",
                "panic",
                "compute",
                "scheduler",
                "swarm",
                "telemetry",
                "fabric",
            ]
        ):
            assistant_line = "Acknowledged. Pulling telemetry."
        elif any(k in t for k in ["strudel", "bitcrush", "sidechain", "reverb", "bassline", "quantize", "modulate", "synth"]):
            assistant_line = "Acknowledged. Warming the synth."
        elif any(k in t for k in ["timeline", "keyframe", "encode", "render", "crt", "glitch", "vhs", "bloom"]):
            assistant_line = "Acknowledged. Splicing the timeline."
        elif any(k in t for k in ["ledger", "reconciliation", "budget", "allocation", "money"]):
            assistant_line = "Acknowledged. Balancing the ledger."
        else:
            assistant_line = "Acknowledged. Running the sweep."

        msgs = [
            {"role": "user", "content": user_line, "timestamp": started_at + 2.0},
            {"role": "assistant", "content": assistant_line, "timestamp": started_at + 8.0},
        ]

        sessions.append(
            {
                "id": sid,
                "source": "cli",
                "model": model,
                "model_config": model_config,
                "system_prompt": system_prompt,
                "started_at": float(started_at),
                "ended_at": float(ended_at),
                "end_reason": "stop",
                "message_count": len(msgs),
                "tool_call_count": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "title": title,
                "messages": msgs,
                "meta_title": title,
            }
        )

    # Write DBs
    _seed_state_db(db_path=state_db_path, sessions=sessions, dry_run=bool(args.dry_run), vacuum=not bool(args.no_vacuum))

    title_map = {s["id"]: s["meta_title"] for s in sessions}
    _seed_meta_db(
        meta_db_path=meta_db_path,
        titles=title_map,
        seed_whispers=bool(args.seed_whispers),
        dry_run=bool(args.dry_run),
    )

    if args.dry_run:
        print("[dry-run] done.")
        return 0

    print("Seed complete.")

    restore_parts = ["./.venv/bin/python", "examples/video-pack/seed_video_history.py"]
    if args.hermes_home:
        restore_parts += ["--hermes-home", str(hermes_home), "--meta-db", str(meta_db_path)]
    else:
        restore_parts += ["--env-file", str(env_path)]
    restore_parts += ["--restore"]

    print("To restore: " + " ".join(shlex.quote(p) for p in restore_parts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
