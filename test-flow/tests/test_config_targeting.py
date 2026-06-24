from pathlib import Path

import pytest

from taproot_mcp.__main__ import main
from taproot_mcp.config import ConfigError, load_config
from taproot_mcp.targeting import TargetError, resolve_target


def write_yaml(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "nodes.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_load_config_merges_defaults_and_expands_key(tmp_path: Path) -> None:
    key = tmp_path / "id_ed25519"
    key.write_text("fake", encoding="utf-8")
    config_path = write_yaml(
        tmp_path,
        f"""
defaults:
  user: admin
  key: {key}
  port: 2222
  sudo_password: secret
nodes:
  gpu-node-1:
    host: 127.0.0.1
    tags: [gpu, vllm]
  dev-vm:
    host: localhost
    user: dev
    password: pw
    tags: [dev]
""",
    )

    config = load_config(config_path)

    assert config.nodes["gpu-node-1"].user == "admin"
    assert config.nodes["gpu-node-1"].port == 2222
    assert config.nodes["gpu-node-1"].sudo_password == "secret"
    assert config.nodes["gpu-node-1"].key == key.expanduser()
    assert config.nodes["dev-vm"].user == "dev"
    assert config.nodes["dev-vm"].password == "pw"


def test_load_config_rejects_missing_host(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
nodes:
  bad-node:
    tags: [gpu]
""",
    )

    with pytest.raises(ConfigError, match="bad-node.*host"):
        load_config(config_path)


def test_load_config_rejects_empty_nodes_by_default(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
defaults:
  user: admin
nodes: {}
""",
    )

    with pytest.raises(ConfigError, match="non-empty mapping"):
        load_config(config_path)


def test_load_config_allows_empty_nodes_when_requested(tmp_path: Path) -> None:
    empty_config_path = write_yaml(
        tmp_path,
        """
defaults:
  user: admin
nodes: {}
""",
    )
    missing_config_path = tmp_path / "missing-nodes.yaml"
    missing_config_path.write_text("defaults:\n  user: admin\n", encoding="utf-8")

    assert load_config(empty_config_path, allow_empty_nodes=True).nodes == {}
    assert load_config(missing_config_path, allow_empty_nodes=True).nodes == {}


def test_validate_command_is_schema_only_and_allows_empty_nodes(tmp_path: Path, capsys) -> None:
    config_path = write_yaml(
        tmp_path,
        """
defaults:
  user: admin
nodes: {}
""",
    )

    assert main(["validate", "--config", str(config_path)]) == 0
    assert "0 node(s)" in capsys.readouterr().out


def test_validate_command_can_require_nodes(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
defaults:
  user: admin
nodes: {}
""",
    )

    assert main(["validate", "--config", str(config_path), "--require-nodes"]) == 2


def test_validate_command_rejects_malformed_nodes(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
nodes:
  bad-node:
    tags: [gpu]
""",
    )

    assert main(["validate", "--config", str(config_path)]) == 2


def test_check_command_still_rejects_empty_nodes(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
defaults:
  user: admin
nodes: {}
""",
    )

    assert main(["check", "--config", str(config_path)]) == 2


def test_load_config_rejects_missing_key_file(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
nodes:
  gpu-node-1:
    host: localhost
    key: /tmp/taproot-key-does-not-exist
""",
    )

    with pytest.raises(ConfigError, match="key.*does not exist"):
        load_config(config_path)


def test_resolve_target_all_tag_glob_and_exact(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
nodes:
  gpu-node-1:
    host: 127.0.0.1
    tags: [gpu, vllm]
  gpu-node-2:
    host: 127.0.0.2
    tags: [gpu]
  dev-vm:
    host: 127.0.0.3
    tags: [dev]
""",
    )
    nodes = load_config(config_path).nodes

    assert resolve_target("all", nodes) == ["gpu-node-1", "gpu-node-2", "dev-vm"]
    assert resolve_target("tag:vllm", nodes) == ["gpu-node-1"]
    assert resolve_target("gpu-*", nodes) == ["gpu-node-1", "gpu-node-2"]
    assert resolve_target("gpu-node-?", nodes) == ["gpu-node-1", "gpu-node-2"]
    assert resolve_target("dev-vm", nodes) == ["dev-vm"]


def test_resolve_target_errors_are_actionable(tmp_path: Path) -> None:
    config_path = write_yaml(
        tmp_path,
        """
nodes:
  gpu-node-1:
    host: 127.0.0.1
    tags: [gpu]
""",
    )
    nodes = load_config(config_path).nodes

    with pytest.raises(TargetError, match="tag:vllm.*no matching nodes"):
        resolve_target("tag:vllm", nodes)

    with pytest.raises(TargetError, match="missing-node.*available nodes.*gpu-node-1"):
        resolve_target("missing-node", nodes)
