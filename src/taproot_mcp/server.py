"""MCP server and tool implementations for taproot-mcp."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import posixpath
import shlex
import stat
import textwrap
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncssh
from mcp.server.fastmcp import FastMCP

from taproot_mcp.config import ClusterConfig
from taproot_mcp.models import Envelope, error_result, make_envelope, ok_result
from taproot_mcp.sessions import SessionManager
from taproot_mcp.ssh_pool import SSHPool
from taproot_mcp.targeting import resolve_target


MAX_READ_FILE_BYTES = 1024 * 1024
TOOL_NAMES = [
    "cluster_exec",
    "cluster_read_file",
    "cluster_edit_file",
    "cluster_write_file",
    "cluster_list_dir",
    "cluster_glob",
    "cluster_system_info",
    "cluster_service",
    "cluster_upload",
    "cluster_download",
    "cluster_session_open",
    "cluster_session_exec",
    "cluster_session_read",
    "cluster_session_interrupt",
    "cluster_session_close",
    "cluster_session_list",
]


class TaprootTools:
    """Tool handler object used by MCP registration and direct tests."""

    def __init__(self, config: ClusterConfig, pool: SSHPool | None = None) -> None:
        """Create tool handlers for one cluster config."""

        self.config = config
        self.pool = pool or SSHPool(config)
        self.sessions = SessionManager(config, self.pool)

    async def aclose(self) -> None:
        """Close network resources held by the tool handlers."""

        await self.pool.close()

    async def cluster_exec(
        self,
        target: str,
        command: str,
        cwd: str | None = None,
        sudo: bool = False,
        sudo_password: str | None = None,
        timeout: int = 30,
    ) -> Envelope:
        """
        在集群节点上执行 shell 命令(无状态:每次在全新 shell 中执行,cd/export 不跨调用保留)。

        target 指定执行范围:
        - 单节点: "gpu-node-1"
        - 通配符: "gpu-*"
        - 按标签: "tag:vllm"
        - 全部节点: "all"

        cwd:可选工作目录,命令将在该目录下执行。sudo=True 时以 root 执行。
        广播到多个节点时会并行执行。返回每个匹配节点的 stdout、stderr、exit_code。
        """

        async def op(node: str) -> dict[str, Any]:
            actual = command
            if cwd:
                actual = f"cd {shlex.quote(cwd)} && {actual}"
            input_data = None
            if sudo:
                actual, input_data = self._sudo_command(node, actual, sudo_password)
            result = await self.pool.run(node, actual, input_data=input_data, timeout=timeout)
            return ok_result(
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=_exit_status(result),
            )

        return await self._on_targets(target, op)

    async def cluster_read_file(self, target: str, path: str) -> Envelope:
        """
        读取集群节点上的文件内容。

        target 语法同 cluster_exec:
        - 单节点: "gpu-node-1"
        - 通配符: "gpu-*"
        - 按标签: "tag:vllm"
        - 全部节点: "all"

        通过 SFTP 读取,返回文件文本内容。超大文件会提示改用 cluster_exec 配合 tail/sed。
        """

        async def op(node: str) -> dict[str, Any]:
            async with self.pool.sftp(node) as sftp:
                data = await _read_remote_bytes(sftp, path, max_bytes=MAX_READ_FILE_BYTES)
            return ok_result(content=data.decode("utf-8", errors="replace"), size=len(data))

        return await self._on_targets(target, op)

    async def cluster_edit_file(
        self,
        target: str,
        path: str,
        old_str: str,
        new_str: str,
        backup: bool = True,
        sudo: bool = False,
        sudo_password: str | None = None,
    ) -> Envelope:
        """
        精确替换集群节点上某文件中的一段内容(对标 Claude Code 的 Edit 工具)。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        old_str 必须在文件中恰好出现一次,替换为 new_str。出现 0 次或多次会报错。
        backup=True 时先备份。sudo=True 时通过临时文件加 sudo mv 写回。
        """

        async def op(node: str) -> dict[str, Any]:
            async with self.pool.sftp(node) as sftp:
                original = await _read_remote_bytes(sftp, path)
                text = original.decode("utf-8", errors="replace")
                count = text.count(old_str)
                if count == 0:
                    return error_result("old_str was not found")
                if count > 1:
                    return error_result("old_str is not unique; provide more context")

                updated = text.replace(old_str, new_str, 1).encode("utf-8")
                backup_path = _backup_path(path) if backup else None
                if backup and backup_path:
                    if sudo:
                        cmd, input_data = self._sudo_command(
                            node,
                            f"cp -p {shlex.quote(path)} {shlex.quote(backup_path)}",
                            sudo_password,
                        )
                        result = await self.pool.run(node, cmd, input_data=input_data, timeout=30)
                        if result.exit_status != 0:
                            return error_result(_command_detail(result, "failed to create backup"))
                    else:
                        await _write_remote_bytes(sftp, backup_path, original)

                if sudo:
                    tmp_path = f"/tmp/taproot-edit-{uuid.uuid4().hex}"
                    await _write_remote_bytes(sftp, tmp_path, updated)
                    cmd, input_data = self._sudo_command(
                        node, f"mv {shlex.quote(tmp_path)} {shlex.quote(path)}", sudo_password
                    )
                    result = await self.pool.run(node, cmd, input_data=input_data, timeout=30)
                    if result.exit_status != 0:
                        return error_result(_command_detail(result, "failed to write file"))
                else:
                    await _write_remote_bytes(sftp, path, updated)

            return ok_result(changed=True, backup_path=backup_path)

        return await self._on_targets(target, op)

    async def cluster_write_file(
        self, target: str, path: str, content: str, backup: bool = True
    ) -> Envelope:
        """
        向集群节点写入文件。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        通过 SFTP 写入。backup=True 时,若目标文件已存在,先备份为 <path>.bak.<时间戳>。
        """

        data = content.encode("utf-8")

        async def op(node: str) -> dict[str, Any]:
            async with self.pool.sftp(node) as sftp:
                attrs = await _try_stat(sftp, path)
                backup_path = None
                if backup and attrs is not None:
                    backup_path = _backup_path(path)
                    old_data = await _read_remote_bytes(sftp, path)
                    await _write_remote_bytes(sftp, backup_path, old_data)
                await _write_remote_bytes(sftp, path, data)
            return ok_result(bytes_written=len(data), backup_path=backup_path)

        return await self._on_targets(target, op)

    async def cluster_list_dir(self, target: str, path: str) -> Envelope:
        """
        列出集群节点上某个目录的内容。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        通过 SFTP 列目录,返回每个条目的名称、类型(file/dir)、大小。
        """

        async def op(node: str) -> dict[str, Any]:
            entries: list[dict[str, Any]] = []
            async with self.pool.sftp(node) as sftp:
                async for entry in sftp.scandir(path):
                    name = _to_text(entry.filename)
                    attrs = entry.attrs
                    permissions = attrs.permissions or 0
                    entries.append(
                        {
                            "name": name,
                            "type": "dir" if stat.S_ISDIR(permissions) else "file",
                            "size": int(attrs.size or 0),
                        }
                    )
            return ok_result(entries=entries)

        return await self._on_targets(target, op)

    async def cluster_glob(self, target: str, pattern: str, path: str = "/") -> Envelope:
        """
        在集群节点上按文件名模式递归查找文件(对标 Claude Code 的 Glob 工具)。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        pattern 如 "*.yaml"、"*.conf"。path 是搜索起点目录。结果上限 200 条。
        """

        async def op(node: str) -> dict[str, Any]:
            command = (
                f"find {shlex.quote(path)} -type f -name {shlex.quote(pattern)} "
                "2>/dev/null | head -n 201"
            )
            result = await self.pool.run(node, command, timeout=60)
            if result.exit_status != 0 and not result.stdout:
                return error_result(_command_detail(result, "find failed"))

            lines = [line for line in result.stdout.splitlines() if line]
            truncated = len(lines) > 200
            matches: list[dict[str, Any]] = []
            async with self.pool.sftp(node) as sftp:
                for found_path in lines[:200]:
                    attrs = await _try_stat(sftp, found_path)
                    if attrs is None:
                        continue
                    modified = datetime.fromtimestamp(
                        float(attrs.mtime or 0), timezone.utc
                    ).isoformat()
                    matches.append(
                        {
                            "path": found_path,
                            "size": int(attrs.size or 0),
                            "modified": modified,
                        }
                    )

            payload = ok_result(matches=matches)
            if truncated:
                payload["truncated"] = True
            return payload

        return await self._on_targets(target, op)

    async def cluster_system_info(self, target: str) -> Envelope:
        """
        获取集群节点的系统状态汇总:主机名、负载、内存、根分区磁盘、GPU。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        GPU 信息通过 nvidia-smi 采集;无 GPU 或无 nvidia-smi 的节点 gpus 为空列表。
        """

        script = _system_info_script()

        async def op(node: str) -> dict[str, Any]:
            result = await self.pool.run(node, script, timeout=30)
            if result.exit_status != 0:
                return error_result(_command_detail(result, "system info failed"))
            try:
                payload = json.loads(result.stdout.strip())
            except json.JSONDecodeError as exc:
                return error_result(f"failed to parse system info JSON: {exc}")
            return ok_result(**payload)

        return await self._on_targets(target, op)

    async def cluster_service(
        self, target: str, service: str, action: str, sudo_password: str | None = None
    ) -> Envelope:
        """
        管理集群节点上的 systemd 服务。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        action 取值: status / start / stop / restart。start/stop/restart 自动以 sudo 执行。
        """

        if action not in {"status", "start", "stop", "restart"}:
            raise ValueError("action must be one of: status, start, stop, restart")

        async def status_op(node: str) -> dict[str, Any]:
            service_q = shlex.quote(service)
            command = (
                f"systemctl is-active {service_q} 2>&1; "
                f"systemctl status --no-pager --lines=5 {service_q} 2>&1 | head -n 12"
            )
            result = await self.pool.run(node, command, timeout=30)
            lines = result.stdout.splitlines()
            active = bool(lines and lines[0].strip() == "active")
            return ok_result(active=active, detail=result.stdout.strip() or result.stderr.strip())

        async def op(node: str) -> dict[str, Any]:
            if action == "status":
                return await status_op(node)
            command = f"systemctl {action} {shlex.quote(service)}"
            sudo_command, input_data = self._sudo_command(node, command, sudo_password)
            result = await self.pool.run(node, sudo_command, input_data=input_data, timeout=60)
            if result.exit_status != 0:
                return error_result(_command_detail(result, f"systemctl {action} failed"))
            return await status_op(node)

        return await self._on_targets(target, op)

    async def cluster_upload(
        self,
        target: str,
        local_path: str,
        remote_path: str,
        mode: str | None = None,
        backup: bool = True,
        sudo: bool = False,
        sudo_password: str | None = None,
    ) -> Envelope:
        """
        把运行本 server 的机器(协调器 = 你的本地机器)上的文件或目录上传到集群节点。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        local_path 为目录时递归上传。mode 可设置权限。backup=True 时目标存在先备份。
        幂等:目标文件 sha256 与本地相同则跳过传输。sudo=True 时暂存到 /tmp 后 sudo mv。
        """

        local = Path(local_path).expanduser()
        if not local.exists():
            raise FileNotFoundError(f"local_path does not exist: {local}")
        mode_int = _parse_mode(mode)
        digest, total_bytes, file_count = _local_digest(local)
        is_dir = local.is_dir()

        async def op(node: str) -> dict[str, Any]:
            remote_digest = await self._remote_digest(node, remote_path, is_dir)
            if remote_digest == digest:
                payload = ok_result(
                    remote_path=remote_path,
                    bytes=total_bytes,
                    sha256=digest,
                    mode=mode,
                    backup_path=None,
                    skipped=True,
                )
                if is_dir:
                    payload["files"] = file_count
                return payload

            tmp_path = f"/tmp/taproot-upload-{uuid.uuid4().hex}-{local.name}"
            backup_path = None
            try:
                async with self.pool.sftp(node) as sftp:
                    if not sudo:
                        await _mkdir_p(sftp, _remote_parent(remote_path))
                    await sftp.put(str(local), tmp_path, recurse=is_dir)

                exists = await self._remote_exists(node, remote_path, sudo, sudo_password)
                if backup and exists:
                    backup_path = _backup_path(remote_path)
                    move_backup = f"mv {shlex.quote(remote_path)} {shlex.quote(backup_path)}"
                    if sudo:
                        move_backup, input_data = self._sudo_command(node, move_backup, sudo_password)
                    else:
                        input_data = None
                    moved = await self.pool.run(
                        node, move_backup, input_data=input_data, timeout=60
                    )
                    if moved.exit_status != 0:
                        return error_result(_command_detail(moved, "failed to backup remote path"))

                move_final = f"mv -f {shlex.quote(tmp_path)} {shlex.quote(remote_path)}"
                if sudo:
                    move_final, input_data = self._sudo_command(node, move_final, sudo_password)
                else:
                    input_data = None
                moved = await self.pool.run(node, move_final, input_data=input_data, timeout=60)
                if moved.exit_status != 0:
                    return error_result(_command_detail(moved, "failed to move upload into place"))

                if mode_int is not None:
                    chmod = f"chmod {mode} {shlex.quote(remote_path)}"
                    if sudo:
                        chmod, input_data = self._sudo_command(node, chmod, sudo_password)
                    else:
                        input_data = None
                    chmod_result = await self.pool.run(
                        node, chmod, input_data=input_data, timeout=30
                    )
                    if chmod_result.exit_status != 0:
                        return error_result(_command_detail(chmod_result, "failed to chmod upload"))
            finally:
                try:
                    await self.pool.run(node, f"rm -rf {shlex.quote(tmp_path)}", timeout=30)
                except Exception:
                    pass

            payload = ok_result(
                remote_path=remote_path,
                bytes=total_bytes,
                sha256=digest,
                mode=mode,
                backup_path=backup_path,
                skipped=False,
            )
            if is_dir:
                payload["files"] = file_count
            return payload

        return await self._on_targets(target, op)

    async def cluster_download(self, target: str, remote_path: str, local_path: str) -> Envelope:
        """
        把集群节点上的文件下载到运行本 server 的机器(协调器 = 你的本地机器)。

        target 语法同 cluster_exec: "gpu-node-1"、"gpu-*"、"tag:vllm"、"all"。
        多节点下载会保存到 local_path/<node>/<basename>,避免互相覆盖。
        """

        node_names = resolve_target(target, self.config.nodes)
        multi = len(node_names) > 1
        base = Path(local_path).expanduser()
        basename = posixpath.basename(remote_path.rstrip("/")) or "download"

        async def op(node: str) -> dict[str, Any]:
            async with self.pool.sftp(node) as sftp:
                attrs = await sftp.stat(remote_path)
                is_dir = stat.S_ISDIR(attrs.permissions or 0)
                if multi:
                    destination = base / node / basename
                elif base.exists() and base.is_dir():
                    destination = base / basename
                else:
                    destination = base
                destination.parent.mkdir(parents=True, exist_ok=True)
                await sftp.get(remote_path, str(destination), recurse=is_dir)

            digest, total_bytes, file_count = _local_digest(destination)
            payload = ok_result(local_path=str(destination), bytes=total_bytes, sha256=digest)
            if is_dir:
                payload["files"] = file_count
            return payload

        return await self._on_node_names(node_names, op)

    async def cluster_session_open(self, node: str) -> Envelope:
        """
        在指定节点上打开一个持久 shell 会话(底层为 tmux),返回 session_id。

        后续用 cluster_session_exec 在同一会话里执行命令,cd/export/source 等状态会保留。
        node 必须是单个节点名,会话不支持广播。单条命令请优先用无状态 cluster_exec。
        """

        return await self.sessions.open(node)

    async def cluster_session_exec(
        self, session_id: str, command: str, timeout: int = 60
    ) -> Envelope:
        """在已打开的会话中执行命令,保留该会话的 shell 状态并返回 output 与 exit_code。"""

        return await self.sessions.exec(session_id, command, timeout)

    async def cluster_session_read(self, session_id: str, lines: int = 100) -> Envelope:
        """读取会话当前的屏幕缓冲,用于查看流式/长时运行命令的最新输出。"""

        return await self.sessions.read(session_id, lines)

    async def cluster_session_interrupt(self, session_id: str) -> Envelope:
        """向会话发送 Ctrl-C,用于中断正在运行的前台命令。"""

        return await self.sessions.interrupt(session_id)

    async def cluster_session_close(self, session_id: str) -> Envelope:
        """关闭会话并释放远端资源。"""

        return await self.sessions.close(session_id)

    async def cluster_session_list(self) -> Envelope:
        """列出当前所有打开的会话及其所在节点。"""

        return await self.sessions.list()

    async def _on_targets(
        self, target: str, op: Callable[[str], Awaitable[dict[str, Any]]]
    ) -> Envelope:
        """Run a per-node operation over a resolved target."""

        return await self._on_node_names(resolve_target(target, self.config.nodes), op)

    async def _on_node_names(
        self, node_names: list[str], op: Callable[[str], Awaitable[dict[str, Any]]]
    ) -> Envelope:
        """Run a per-node operation in parallel and envelope failures."""

        outcomes = await asyncio.gather(
            *(op(node_name) for node_name in node_names), return_exceptions=True
        )
        results: dict[str, dict[str, Any]] = {}
        for node_name, outcome in zip(node_names, outcomes, strict=True):
            if isinstance(outcome, Exception):
                results[node_name] = error_result(_format_exception(outcome))
            else:
                results[node_name] = outcome
        return make_envelope(results)

    def _sudo_command(
        self, node: str, command: str, sudo_password: str | None
    ) -> tuple[str, str | None]:
        """Wrap a shell command in sudo and prepare stdin password input."""

        password = sudo_password or self.config.nodes[node].sudo_password
        input_data = f"{password}\n" if password else None
        return f"sudo -S -p '' sh -c {shlex.quote(command)}", input_data

    async def _remote_sha256(self, node: str, path: str) -> str | None:
        """Return a remote file sha256, or None if unavailable/not found."""

        command = (
            f"if [ ! -f {shlex.quote(path)} ]; then exit 2; fi; "
            "if command -v sha256sum >/dev/null 2>&1; then "
            f"sha256sum {shlex.quote(path)} | awk '{{print $1}}'; "
            "elif command -v shasum >/dev/null 2>&1; then "
            f"shasum -a 256 {shlex.quote(path)} | awk '{{print $1}}'; "
            "elif command -v python3 >/dev/null 2>&1; then "
            "python3 -c 'import hashlib,sys; "
            "print(hashlib.sha256(open(sys.argv[1],\"rb\").read()).hexdigest())' "
            f"{shlex.quote(path)}; "
            "else exit 127; fi"
        )
        result = await self.pool.run(node, command, timeout=60)
        if result.exit_status != 0:
            return None
        digest = result.stdout.strip().splitlines()
        return digest[0] if digest else None

    async def _remote_digest(self, node: str, path: str, is_dir: bool) -> str | None:
        """Return remote sha256 for a file or deterministic digest for a directory."""

        if not is_dir:
            return await self._remote_sha256(node, path)

        script = r"""
import hashlib
import os
import sys

root = sys.argv[1]
if not os.path.isdir(root):
    raise SystemExit(2)

digest = hashlib.sha256()
for dirpath, _, filenames in os.walk(root):
    for filename in sorted(filenames):
        path = os.path.join(dirpath, filename)
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        file_digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                file_digest.update(chunk)
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_digest.hexdigest().encode("ascii"))
        digest.update(b"\0")
print(digest.hexdigest())
"""
        command = (
            f"python3 - {shlex.quote(path)} <<'PY'\n"
            + textwrap.dedent(script).strip()
            + "\nPY"
        )
        result = await self.pool.run(node, command, timeout=120)
        if result.exit_status != 0:
            return None
        digest = result.stdout.strip().splitlines()
        return digest[0] if digest else None

    async def _remote_exists(
        self, node: str, path: str, sudo: bool, sudo_password: str | None
    ) -> bool:
        """Check whether a remote path exists."""

        command = f"test -e {shlex.quote(path)}"
        input_data = None
        if sudo:
            command, input_data = self._sudo_command(node, command, sudo_password)
        result = await self.pool.run(node, command, input_data=input_data, timeout=30)
        return result.exit_status == 0


def build_mcp_server(
    tools: TaprootTools, host: str = "127.0.0.1", port: int = 8000
) -> FastMCP:
    """Build a FastMCP server and register taproot tools."""

    mcp = FastMCP(
        "taproot-mcp",
        host=host,
        port=port,
        log_level="ERROR",
        stateless_http=True,
        json_response=True,
    )
    for tool_name in TOOL_NAMES:
        mcp.tool()(getattr(tools, tool_name))
    return mcp


async def _read_remote_bytes(
    sftp: asyncssh.SFTPClient, path: str, max_bytes: int | None = None
) -> bytes:
    """Read a remote file with an optional size limit."""

    attrs = await sftp.stat(path)
    size = int(attrs.size or 0)
    if max_bytes is not None and size > max_bytes:
        raise ValueError(
            f"file is {size} bytes, above {max_bytes} byte limit; "
            "use cluster_exec with tail/sed to read a slice"
        )
    async with sftp.open(path, "rb", encoding=None) as remote:
        data = await remote.read()
    if isinstance(data, str):
        return data.encode("utf-8")
    return data


async def _write_remote_bytes(sftp: asyncssh.SFTPClient, path: str, data: bytes) -> None:
    """Write bytes to a remote path via SFTP."""

    async with sftp.open(path, "wb", encoding=None) as remote:
        await remote.write(data)


async def _try_stat(sftp: asyncssh.SFTPClient, path: str) -> asyncssh.SFTPAttrs | None:
    """Return remote stat attrs, or None when the path does not exist."""

    try:
        return await sftp.stat(path)
    except (asyncssh.SFTPNoSuchFile, asyncssh.SFTPNoSuchPath, FileNotFoundError):
        return None


async def _mkdir_p(sftp: asyncssh.SFTPClient, path: str) -> None:
    """Create remote directories recursively via SFTP."""

    if not path or path == "/":
        return
    current = "/" if path.startswith("/") else ""
    for part in [part for part in path.split("/") if part]:
        current = posixpath.join(current, part) if current else part
        try:
            await sftp.mkdir(current)
        except asyncssh.SFTPFailure:
            attrs = await _try_stat(sftp, current)
            if attrs is None or not stat.S_ISDIR(attrs.permissions or 0):
                raise
        except asyncssh.SFTPError as exc:
            if "File exists" not in str(exc):
                raise


def _remote_parent(path: str) -> str:
    """Return the POSIX parent directory for a remote path."""

    parent = posixpath.dirname(path.rstrip("/"))
    return parent or "."


def _backup_path(path: str) -> str:
    """Build a timestamped backup path."""

    return f"{path}.bak.{datetime.now().strftime('%Y%m%d-%H%M%S')}"


def _parse_mode(mode: str | None) -> int | None:
    """Validate an optional chmod mode string."""

    if mode is None:
        return None
    if not mode or any(char not in "01234567" for char in mode):
        raise ValueError('mode must be an octal string like "755"')
    return int(mode, 8)


def _local_digest(path: Path) -> tuple[str, int, int]:
    """Return sha256, total byte count, and file count for a local file or tree."""

    if path.is_file():
        return _file_digest(path), path.stat().st_size, 1

    if not path.is_dir():
        raise FileNotFoundError(f"local path is neither file nor directory: {path}")

    digest = hashlib.sha256()
    total = 0
    count = 0
    for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
        rel = file_path.relative_to(path).as_posix()
        file_hash = _file_digest(file_path)
        size = file_path.stat().st_size
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_hash.encode("ascii"))
        digest.update(b"\0")
        total += size
        count += 1
    return digest.hexdigest(), total, count


def _file_digest(path: Path) -> str:
    """Return sha256 for a local file."""

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _system_info_script() -> str:
    """Return the remote Python script used to collect structured system info."""

    python = r"""
import json
import os
import shutil
import socket
import subprocess

def memory():
    try:
        info = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                key, value = line.split(":", 1)
                info[key] = int(value.strip().split()[0]) * 1024
        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", info.get("MemFree", 0))
        return {"total_bytes": total, "used_bytes": max(total - available, 0)}
    except Exception:
        try:
            total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except Exception:
            total = 0
        return {"total_bytes": int(total), "used_bytes": 0}

def gpus():
    query = "index,name,memory.total,memory.used,utilization.gpu,temperature.gpu"
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                f"--query-gpu={query}",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:
        return []
    if result.returncode != 0:
        return []
    rows = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 6:
            continue
        rows.append(
            {
                "index": int(parts[0]),
                "name": parts[1],
                "mem_total_mb": int(parts[2]),
                "mem_used_mb": int(parts[3]),
                "util_pct": int(parts[4]),
                "temp_c": int(parts[5]),
            }
        )
    return rows

disk = shutil.disk_usage("/")
print(
    json.dumps(
        {
            "hostname": socket.gethostname(),
            "load": [float(value) for value in os.getloadavg()],
            "memory": memory(),
            "disk_root": {
                "total_bytes": int(disk.total),
                "used_bytes": int(disk.used),
            },
            "gpus": gpus(),
        }
    )
)
"""
    return "python3 - <<'PY'\n" + textwrap.dedent(python).strip() + "\nPY"


def _command_detail(result: asyncssh.SSHCompletedProcess, fallback: str) -> str:
    """Return a readable detail from an SSH command result."""

    detail = result.stderr.strip() or result.stdout.strip()
    if detail:
        return detail
    return f"{fallback} (exit {_exit_status(result)})"


def _exit_status(result: asyncssh.SSHCompletedProcess) -> int:
    """Normalize AsyncSSH exit status."""

    return int(result.exit_status if result.exit_status is not None else -1)


def _format_exception(exc: Exception) -> str:
    """Format exceptions for per-node failed results."""

    if isinstance(exc, asyncio.TimeoutError):
        return "timeout"
    text = str(exc)
    return text or exc.__class__.__name__


def _to_text(value: bytes | str) -> str:
    """Convert SFTP bytes/str names to text."""

    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
