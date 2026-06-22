from pathlib import Path
from types import SimpleNamespace

import pytest

from taproot_mcp.approvals import ApprovalStore
from taproot_mcp.config import ClusterConfig, NodeConfig
from taproot_mcp.history import read_history
from taproot_mcp.server import TaprootTools


pytestmark = pytest.mark.asyncio


class FakePool:
    def __init__(self) -> None:
        self.calls = 0

    async def run(self, node: str, command: str, **kwargs):
        self.calls += 1
        return SimpleNamespace(stdout=f"{node}: {command}", stderr="", exit_status=0)

    async def close(self) -> None:
        return None


async def test_cluster_exec_writes_per_node_history(tmp_path: Path) -> None:
    config_path = tmp_path / "nodes.yaml"
    config_path.write_text("nodes: {}\n", encoding="utf-8")
    config = ClusterConfig(
        path=config_path,
        nodes={
            "local-a": NodeConfig(name="local-a", host="localhost"),
            "local-b": NodeConfig(name="local-b", host="localhost"),
        },
    )
    pool = FakePool()
    tools = TaprootTools(config, pool=pool)  # type: ignore[arg-type]

    result = await tools.cluster_exec("local-*", "echo ok", sudo=True, sudo_password="secret")
    assert result["summary"] == {"success": 0, "failed": 2, "total": 2}
    assert pool.calls == 0
    approval_id = result["results"]["local-a"]["approval_id"]
    ApprovalStore(config).approve(approval_id)

    result = await tools.cluster_exec("local-*", "echo ok", sudo=True, sudo_password="secret")
    assert result["summary"] == {"success": 2, "failed": 0, "total": 2}
    local_a = read_history(config, node="local-a")
    local_b = read_history(config, node="local-b")

    assert len(local_a) == 1
    assert len(local_b) == 1
    assert local_a[0]["tool"] == "cluster_exec"
    assert local_a[0]["action"] == "exec"
    assert local_a[0]["summary"] == "执行 bash: echo ok"
    assert local_a[0]["detail"]["command"] == "echo ok"
    assert "sudo_password" not in local_a[0]["detail"]


async def test_write_file_history_records_content_preview(tmp_path: Path) -> None:
    config_path = tmp_path / "nodes.yaml"
    config_path.write_text("nodes: {}\n", encoding="utf-8")
    config = ClusterConfig(
        path=config_path,
        nodes={"local": NodeConfig(name="local", host="localhost")},
    )
    tools = TaprootTools(config)

    tools._record_envelope(  # type: ignore[attr-defined]
        "cluster_write_file",
        "local",
        {"path": "/tmp/config.yaml", "content": "secret text", "bytes": 11},
        {
            "results": {"local": {"ok": True, "backup_path": "~/.taproot/backups/hash/file"}},
            "summary": {"success": 1, "failed": 0, "total": 1},
        },
    )

    event = read_history(config, node="local")[0]
    assert event["summary"] == "写入文件: /tmp/config.yaml"
    assert event["detail"]["path"] == "/tmp/config.yaml"
    assert event["detail"]["bytes"] == 11
    assert "content" not in event["detail"]
    assert event["detail"]["content_preview"] == "secret text"
    assert event["detail"]["content_truncated"] is False
    assert event["detail"]["backup_path"] == "~/.taproot/backups/hash/file"
