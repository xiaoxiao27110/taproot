import json
from pathlib import Path

from taproot_mcp.__main__ import main
from taproot_mcp.approvals import ApprovalStore
from taproot_mcp.config import ClusterConfig, NodeConfig


def test_approval_store_and_cli_lifecycle(tmp_path: Path, capsys) -> None:
    config_path = tmp_path / "nodes.yaml"
    config_path.write_text(
        """
nodes:
  local:
    host: 127.0.0.1
""",
        encoding="utf-8",
    )
    config = ClusterConfig(
        path=config_path,
        nodes={"local": NodeConfig(name="local", host="127.0.0.1")},
    )
    approval = ApprovalStore(config).request(
        "cluster_exec",
        "local",
        {"command": "whoami", "sudo_password": "secret"},
    )

    assert main(["approvals", "list", "--config", str(config_path), "--status", "pending"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed[0]["id"] == approval["id"]
    assert "sudo_password" not in listed[0]["details"]

    assert main(["approvals", "approve", approval["id"], "--config", str(config_path)]) == 0
    approved = json.loads(capsys.readouterr().out)
    assert approved["status"] == "approved"

    store = ApprovalStore(config)
    assert store.consume("cluster_exec", "local", {"command": "whoami"}) is not None
    assert store.consume("cluster_exec", "local", {"command": "whoami"}) is None
