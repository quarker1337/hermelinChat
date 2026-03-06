from __future__ import annotations

import os
import pty
import signal
import struct
import subprocess
import termios
import fcntl
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def set_winsize(fd: int, *, cols: int, rows: int) -> None:
    # struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@dataclass
class PtyProcess:
    master_fd: int
    proc: subprocess.Popen

    @classmethod
    def spawn(
        cls,
        argv: list[str],
        *,
        cwd: Optional[Path] = None,
        env: Optional[dict[str, str]] = None,
        cols: int = 120,
        rows: int = 30,
    ) -> "PtyProcess":
        master_fd, slave_fd = pty.openpty()
        set_winsize(slave_fd, cols=cols, rows=rows)

        proc = subprocess.Popen(
            argv,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=str(cwd) if cwd else None,
            env=env,
            start_new_session=True,  # own process group
        )

        # Parent no longer needs slave
        os.close(slave_fd)
        return cls(master_fd=master_fd, proc=proc)

    def resize(self, *, cols: int, rows: int) -> None:
        try:
            set_winsize(self.master_fd, cols=cols, rows=rows)
        except OSError:
            return

        # Nudge apps that listen for SIGWINCH
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass

    def write(self, data: bytes) -> None:
        os.write(self.master_fd, data)

    def terminate(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def kill(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def close_fds(self) -> None:
        try:
            os.close(self.master_fd)
        except OSError:
            pass
