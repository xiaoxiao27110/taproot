"""AsyncSSH connection pool and low-level SSH primitives."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncssh

from taproot_mcp.config import ClusterConfig, NodeConfig


class SSHPool:
    """Lazy AsyncSSH connection pool keyed by node name."""

    def __init__(self, config: ClusterConfig, connect_timeout: float = 10.0) -> None:
        """Create a connection pool for a validated cluster config."""

        self.config = config
        self.connect_timeout = connect_timeout
        self._connections: dict[str, asyncssh.SSHClientConnection] = {}

    async def close(self) -> None:
        """Close all cached SSH connections."""

        for conn in self._connections.values():
            conn.close()
        for conn in self._connections.values():
            try:
                await conn.wait_closed()
            except Exception:
                pass
        self._connections.clear()

    async def get(self, node_name: str) -> asyncssh.SSHClientConnection:
        """Return a live SSH connection for a node, reconnecting if needed."""

        node = self._node(node_name)
        conn = self._connections.get(node_name)
        if conn is not None and not conn.is_closed():
            return conn

        conn = await self._connect(node)
        self._connections[node_name] = conn
        return conn

    async def run(
        self,
        node_name: str,
        command: str,
        *,
        input_data: str | None = None,
        timeout: float | None = None,
    ) -> asyncssh.SSHCompletedProcess:
        """Run a command on a node, retrying once after a stale connection."""

        conn = await self.get(node_name)
        try:
            return await conn.run(command, input=input_data, check=False, timeout=timeout)
        except (asyncssh.Error, OSError, BrokenPipeError):
            await self._discard(node_name)
            conn = await self.get(node_name)
            return await conn.run(command, input=input_data, check=False, timeout=timeout)

    @asynccontextmanager
    async def sftp(self, node_name: str) -> AsyncIterator[asyncssh.SFTPClient]:
        """Open an SFTP client on a pooled SSH connection."""

        conn = await self.get(node_name)
        try:
            async with conn.start_sftp_client() as sftp:
                yield sftp
        except (asyncssh.Error, OSError, BrokenPipeError):
            await self._discard(node_name)
            raise

    async def check_node(self, node_name: str) -> tuple[bool, str]:
        """Check whether one node can be reached over SSH."""

        try:
            result = await self.run(node_name, "printf ok", timeout=self.connect_timeout)
        except Exception as exc:
            return False, str(exc)
        if result.exit_status == 0:
            return True, "ok"
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.exit_status}"
        return False, detail

    def _node(self, node_name: str) -> NodeConfig:
        """Return config for one node or raise a clear error."""

        try:
            return self.config.nodes[node_name]
        except KeyError as exc:
            raise KeyError(f"unknown node: {node_name}") from exc

    async def _connect(self, node: NodeConfig) -> asyncssh.SSHClientConnection:
        """Create a new AsyncSSH connection for a node."""

        kwargs: dict[str, object] = {
            "port": node.port,
            "connect_timeout": self.connect_timeout,
            "keepalive_interval": 30,
            "keepalive_count_max": 3,
        }
        if node.user:
            kwargs["username"] = node.user
        if node.key:
            kwargs["client_keys"] = [str(node.key)]
        if node.password:
            kwargs["password"] = node.password

        return await asyncssh.connect(node.host, **kwargs)

    async def _discard(self, node_name: str) -> None:
        """Remove and close a cached connection."""

        conn = self._connections.pop(node_name, None)
        if conn is None:
            return
        conn.close()
        try:
            await conn.wait_closed()
        except Exception:
            pass
