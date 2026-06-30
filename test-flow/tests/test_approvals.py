import json
from pathlib import Path

from taproot_mcp.__main__ import main
from taproot_mcp.approvals import CLI_APPROVAL_ENV, ApprovalStore
from taproot_mcp.config import ClusterConfig, NodeConfig


def make_config(tmp_path: Path) -> tuple[Path, ClusterConfig]:
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
    return config_path, config


def test_approval_store_and_cli_lifecycle(tmp_path: Path, capsys, monkeypatch) -> None:
    config_path, config = make_config(tmp_path)
    approval = ApprovalStore(config).request(
        "cluster_exec",
        "local",
        {"command": "whoami", "sudo_password": "secret"},
    )

    assert main(["approvals", "list", "--config", str(config_path), "--status", "pending"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed[0]["id"] == approval["id"]
    assert "sudo_password" not in listed[0]["details"]

    assert main(["approvals", "approve", approval["id"], "--config", str(config_path)]) == 2
    assert "CLI approval changes are disabled by default" in capsys.readouterr().err

    monkeypatch.setenv(CLI_APPROVAL_ENV, "1")
    assert main(["approvals", "approve", approval["id"], "--config", str(config_path)]) == 0
    approved = json.loads(capsys.readouterr().out)
    assert approved["status"] == "approved"

    store = ApprovalStore(config)
    assert store.consume("cluster_exec", "local", {"command": "whoami"}) is not None
    assert store.consume("cluster_exec", "local", {"command": "whoami"}) is None


def test_remembered_approval_reuses_matching_command(tmp_path: Path) -> None:
    _, config = make_config(tmp_path)
    store = ApprovalStore(config)
    approval = store.request("cluster_exec", "local", {"command": "printf   ok\n"})

    store.remember(approval["id"])

    assert store.consume("cluster_exec", "local", {"command": "printf ok"}) is not None
    assert store.consume("cluster_exec", "local", {"command": "printf ok"}) is not None
    assert store.consume("cluster_exec", "local", {"command": "printf no"}) is None


def test_approval_details_redact_sensitive_values_but_hash_content(tmp_path: Path) -> None:
    _, config = make_config(tmp_path)
    store = ApprovalStore(config)
    approval = store.request(
        "cluster_write_file",
        "local",
        {
            "path": "/tmp/example.txt",
            "content": "secret file body",
            "old_str": "before",
            "new_str": "after",
            "password": "node-password",
            "sudo_password": "sudo-password",
        },
    )

    details = approval["details"]
    assert "content" not in details
    assert "old_str" not in details
    assert "new_str" not in details
    assert "password" not in details
    assert "sudo_password" not in details
    assert "content_sha256" in details
    assert "old_str_sha256" in details
    assert "new_str_sha256" in details

    store.remember(approval["id"])
    assert (
        store.consume(
            "cluster_write_file",
            "local",
            {
                "path": "/tmp/example.txt",
                "content": "secret file body",
                "old_str": "before",
                "new_str": "after",
            },
        )
        is not None
    )
    assert (
        store.consume(
            "cluster_write_file",
            "local",
            {
                "path": "/tmp/example.txt",
                "content": "changed body",
                "old_str": "before",
                "new_str": "after",
            },
        )
        is None
    )
