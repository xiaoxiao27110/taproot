"""tmux-backed stateful session management for v0.2 tools."""

from __future__ import annotations

import asyncio
import re
import shlex
import uuid
from dataclasses import dataclass
from time import monotonic
from typing import Any

from taproot_mcp.config import ClusterConfig
from taproot_mcp.models import error_result, make_envelope, ok_result
from taproot_mcp.ssh_pool import SSHPool


@dataclass(frozen=True)
class SessionRecord:
    """In-memory mapping from session ID to node and tmux name."""

    session_id: str
    node: str
    tmux_name: str
    tmux_bin: str


class SessionManager:
    """Manage remote tmux sessions over SSH."""

    def __init__(self, config: ClusterConfig, pool: SSHPool) -> None:
        """Create a tmux session manager reusing an SSH pool."""

        self.config = config
        self.pool = pool
        self._sessions: dict[str, SessionRecord] = {}
        self._tmux_bins: dict[str, str] = {}

    async def open(self, node: str) -> dict[str, Any]:
        """Open a tmux-backed session on one node."""

        if node not in self.config.nodes:
            return make_envelope({node: error_result(f"unknown node: {node}")})

        tmux_bin = await self._detect_tmux(node)
        if tmux_bin is None:
            detail = "tmux not found"
            return make_envelope({node: error_result(detail)})

        session_id = uuid.uuid4().hex[:10]
        tmux_name = f"taproot-{session_id}"
        result = await self.pool.run(
            node,
            f"{shlex.quote(tmux_bin)} new-session -d -s {shlex.quote(tmux_name)}",
            timeout=10,
        )
        if result.exit_status != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "failed to open tmux"
            return make_envelope({node: error_result(detail)})

        self._sessions[session_id] = SessionRecord(session_id, node, tmux_name, tmux_bin)
        return make_envelope(
            {node: ok_result(session_id=session_id, node=node, tmux_session=tmux_name)}
        )

    async def exec(self, session_id: str, command: str, timeout: int = 60) -> dict[str, Any]:
        """Execute a command inside a persistent tmux session."""

        record = self._sessions.get(session_id)
        if record is None:
            return make_envelope({"unknown": error_result(f"unknown session_id: {session_id}")})

        marker = uuid.uuid4().hex
        token = f"TAPROOT_DONE_{marker}"
        wrapped = f"{command}; printf '\\n{token} %d\\n' $?"
        send_command = (
            f"{shlex.quote(record.tmux_bin)} send-keys -t {shlex.quote(record.tmux_name)} -- "
            f"{shlex.quote(wrapped)} C-m"
        )
        sent = await self.pool.run(record.node, send_command, timeout=10)
        if sent.exit_status != 0:
            detail = sent.stderr.strip() or sent.stdout.strip() or "failed to send command"
            return make_envelope({record.node: error_result(detail)})

        deadline = monotonic() + timeout
        last_output = ""
        while monotonic() < deadline:
            captured = await self._capture(record, lines=2000)
            if captured["ok"] is not True:
                return make_envelope({record.node: captured})
            last_output = str(captured["output"])
            parsed = _parse_sentinel_output(last_output, token, wrapped)
            if parsed is not None:
                output, exit_code = parsed
                return make_envelope({record.node: ok_result(output=output, exit_code=exit_code)})
            await asyncio.sleep(0.2)

        return make_envelope(
            {
                record.node: error_result(
                    "timeout waiting for session command sentinel; command may still be running. "
                    "Use cluster_session_read to inspect output."
                )
            }
        )

    async def read(self, session_id: str, lines: int = 100) -> dict[str, Any]:
        """Read the current tmux pane buffer for a session."""

        record = self._sessions.get(session_id)
        if record is None:
            return make_envelope({"unknown": error_result(f"unknown session_id: {session_id}")})

        captured = await self._capture(record, lines=max(1, lines))
        return make_envelope({record.node: captured})

    async def interrupt(self, session_id: str) -> dict[str, Any]:
        """Send Ctrl-C to a tmux session."""

        record = self._sessions.get(session_id)
        if record is None:
            return make_envelope({"unknown": error_result(f"unknown session_id: {session_id}")})

        result = await self.pool.run(
            record.node,
            f"{shlex.quote(record.tmux_bin)} send-keys -t {shlex.quote(record.tmux_name)} C-c",
            timeout=10,
        )
        if result.exit_status != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "failed to interrupt session"
            return make_envelope({record.node: error_result(detail)})
        return make_envelope({record.node: ok_result()})

    async def close(self, session_id: str) -> dict[str, Any]:
        """Close a tmux session and remove it from the registry."""

        record = self._sessions.pop(session_id, None)
        if record is None:
            return make_envelope({"unknown": error_result(f"unknown session_id: {session_id}")})

        result = await self.pool.run(
            record.node,
            f"{shlex.quote(record.tmux_bin)} kill-session -t {shlex.quote(record.tmux_name)}",
            timeout=10,
        )
        if result.exit_status != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "failed to close session"
            return make_envelope({record.node: error_result(detail)})
        return make_envelope({record.node: ok_result(closed=True)})

    async def list(self) -> dict[str, Any]:
        """List taproot tmux sessions visible on configured nodes."""

        sessions: list[dict[str, str]] = []
        for node in self.config.nodes:
            tmux_bin = await self._detect_tmux(node)
            if tmux_bin is None:
                continue
            try:
                result = await self.pool.run(
                    node,
                    f"{shlex.quote(tmux_bin)} ls 2>/dev/null | "
                    "awk -F: '/^taproot-/ {print $1}' || true",
                    timeout=10,
                )
            except Exception:
                continue
            for tmux_name in result.stdout.splitlines():
                tmux_name = tmux_name.strip()
                if not tmux_name.startswith("taproot-"):
                    continue
                session_id = tmux_name.removeprefix("taproot-")
                sessions.append({"session_id": session_id, "node": node})
                self._sessions.setdefault(
                    session_id, SessionRecord(session_id, node, tmux_name, tmux_bin)
                )

        return make_envelope({"sessions": ok_result(sessions=sessions)})

    async def _capture(self, record: SessionRecord, lines: int) -> dict[str, Any]:
        """Capture the current pane output for one session."""

        result = await self.pool.run(
            record.node,
            f"{shlex.quote(record.tmux_bin)} capture-pane -p "
            f"-t {shlex.quote(record.tmux_name)} -S -{int(lines)}",
            timeout=10,
        )
        if result.exit_status != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "failed to capture session"
            return error_result(detail)
        output_lines = result.stdout.splitlines()
        return ok_result(output="\n".join(output_lines[-lines:]))

    async def _detect_tmux(self, node: str) -> str | None:
        """Find a tmux binary on a node, including common macOS Homebrew paths."""

        cached = self._tmux_bins.get(node)
        if cached:
            return cached

        command = (
            "for candidate in tmux /opt/homebrew/bin/tmux /usr/local/bin/tmux; do "
            "if command -v \"$candidate\" >/dev/null 2>&1; then "
            "command -v \"$candidate\"; exit 0; fi; "
            "done; exit 127"
        )
        result = await self.pool.run(node, command, timeout=10)
        if result.exit_status != 0:
            return None
        tmux_bin = result.stdout.strip().splitlines()[0]
        self._tmux_bins[node] = tmux_bin
        return tmux_bin


def _parse_sentinel_output(
    text: str, token: str, wrapped_command: str
) -> tuple[str, int] | None:
    """Parse tmux capture output for a sentinel marker and exit code."""

    lines = text.splitlines()
    marker_index: int | None = None
    exit_code: int | None = None
    pattern = re.compile(rf"{re.escape(token)}\s+(\d+)")

    for index in range(len(lines) - 1, -1, -1):
        match = pattern.search(lines[index])
        if match:
            marker_index = index
            exit_code = int(match.group(1))
            break

    if marker_index is None or exit_code is None:
        return None

    output_lines = []
    for line in lines[:marker_index]:
        stripped = line.strip()
        if token in line:
            continue
        if stripped == wrapped_command:
            continue
        output_lines.append(line.rstrip())

    output = "\n".join(output_lines).strip()
    return output, exit_code
