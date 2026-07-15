from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


RUNTIME_STATES = {"starting", "idle", "running", "detached", "stopped", "error"}
RUNTIME_SOURCES = {"user_ui", "internal", "fleet_worker"}
RUNTIME_BACKENDS = {"tmux", "legacy"}


def utc_ts(now: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))


def new_runtime_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass(slots=True)
class RuntimeRecord:
    runtime_id: str
    title: str = "New session"
    profile: str = "default"
    cwd: str = ""
    state: str = "starting"
    source: str = "user_ui"
    backend: str = "tmux"
    tmux_name: str | None = None
    hermes_pid: int | None = None
    active_hermes_session_id: str | None = None
    created_at: str = field(default_factory=utc_ts)
    updated_at: str = field(default_factory=utc_ts)
    last_attached_at: str | None = None
    last_seen_at: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "RuntimeRecord":
        data = dict(raw or {})
        data["runtime_id"] = str(data.get("runtime_id") or data.get("id") or new_runtime_id())
        data["title"] = str(data.get("title") or "New session")
        data["profile"] = str(data.get("profile") or "default")
        data["cwd"] = str(data.get("cwd") or "")
        data["state"] = str(data.get("state") or "starting")
        if data["state"] not in RUNTIME_STATES:
            data["state"] = "error"
        data["source"] = str(data.get("source") or "user_ui")
        if data["source"] not in RUNTIME_SOURCES:
            data["source"] = "user_ui"
        data["backend"] = str(data.get("backend") or "tmux")
        if data["backend"] not in RUNTIME_BACKENDS:
            data["backend"] = "legacy"
        metadata = data.get("metadata")
        data["metadata"] = metadata if isinstance(metadata, dict) else {}
        for key in ("tmux_name", "active_hermes_session_id", "last_attached_at", "last_seen_at"):
            value = data.get(key)
            data[key] = str(value) if value not in (None, "") else None
        try:
            pid = int(data.get("hermes_pid")) if data.get("hermes_pid") not in (None, "") else None
        except Exception:
            pid = None
        data["hermes_pid"] = pid
        created_at = str(data.get("created_at") or utc_ts())
        updated_at = str(data.get("updated_at") or utc_ts())
        return cls(
            runtime_id=str(data["runtime_id"]),
            title=str(data["title"]),
            profile=str(data["profile"]),
            cwd=str(data["cwd"]),
            state=str(data["state"]),
            source=str(data["source"]),
            backend=str(data["backend"]),
            tmux_name=data.get("tmux_name"),
            hermes_pid=pid,
            active_hermes_session_id=data.get("active_hermes_session_id"),
            created_at=created_at,
            updated_at=updated_at,
            last_attached_at=data.get("last_attached_at"),
            last_seen_at=data.get("last_seen_at"),
            metadata=data["metadata"],
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class RuntimeRegistry:
    def __init__(self, path: Path):
        self.path = Path(path).expanduser()

    def _default_data(self) -> dict[str, Any]:
        return {"version": 1, "last_active_runtime_id": None, "runtimes": []}

    def _read(self) -> dict[str, Any]:
        try:
            if not self.path.exists():
                return self._default_data()
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return self._default_data()
            if not isinstance(data.get("runtimes"), list):
                data["runtimes"] = []
            return data
        except Exception:
            return self._default_data()

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.path)

    def list_runtimes(self) -> list[RuntimeRecord]:
        data = self._read()
        records = [RuntimeRecord.from_dict(item) for item in data.get("runtimes", []) if isinstance(item, dict)]
        records.sort(key=lambda r: r.created_at)
        return records

    def get_runtime(self, runtime_id: str) -> RuntimeRecord | None:
        rid = str(runtime_id or "").strip()
        if not rid:
            return None
        for record in self.list_runtimes():
            if record.runtime_id == rid:
                return record
        return None

    def create_runtime(self, record: RuntimeRecord) -> RuntimeRecord:
        data = self._read()
        runtimes = [item for item in data.get("runtimes", []) if isinstance(item, dict)]
        if any(str(item.get("runtime_id")) == record.runtime_id for item in runtimes):
            raise ValueError(f"runtime already exists: {record.runtime_id}")
        record.updated_at = utc_ts()
        runtimes.append(record.to_dict())
        data["runtimes"] = runtimes
        data["last_active_runtime_id"] = record.runtime_id
        self._write(data)
        return record

    def update_runtime(self, runtime_id: str, **fields: Any) -> RuntimeRecord:
        data = self._read()
        runtimes = [item for item in data.get("runtimes", []) if isinstance(item, dict)]
        now = utc_ts()
        for idx, item in enumerate(runtimes):
            if str(item.get("runtime_id")) != str(runtime_id):
                continue
            next_item = dict(item)
            for key, value in fields.items():
                if key == "runtime_id":
                    continue
                next_item[key] = value
            next_item["updated_at"] = now
            record = RuntimeRecord.from_dict(next_item)
            runtimes[idx] = record.to_dict()
            data["runtimes"] = runtimes
            self._write(data)
            return record
        raise KeyError(runtime_id)

    def mark_stopped(self, runtime_id: str) -> RuntimeRecord:
        return self.update_runtime(runtime_id, state="stopped", last_seen_at=utc_ts())

    def remember_last_active(self, runtime_id: str) -> None:
        data = self._read()
        data["last_active_runtime_id"] = str(runtime_id)
        self._write(data)

    def get_last_active(self) -> str | None:
        value = self._read().get("last_active_runtime_id")
        return str(value) if value else None

    def ensure_default_runtime(self, *, backend: str, title: str = "New session", cwd: str = "", profile: str = "default", tmux_name: str | None = None) -> RuntimeRecord:
        last = self.get_last_active()
        if last:
            found = self.get_runtime(last)
            if found and found.state != "stopped":
                return found
        for record in self.list_runtimes():
            if record.state != "stopped":
                self.remember_last_active(record.runtime_id)
                return record
        record = RuntimeRecord(
            runtime_id=new_runtime_id(),
            title=title,
            cwd=cwd,
            profile=profile,
            backend=backend,
            tmux_name=tmux_name,
        )
        return self.create_runtime(record)
