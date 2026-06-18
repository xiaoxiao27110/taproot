from pathlib import Path

import pytest

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
