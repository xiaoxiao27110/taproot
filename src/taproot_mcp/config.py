"""Configuration loading and validation for taproot-mcp."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class ConfigError(ValueError):
    """Raised when nodes.yaml is missing or invalid."""


@dataclass(frozen=True)
class NodeConfig:
    """Effective SSH configuration for one cluster node."""

    name: str
    host: str
    user: str | None = None
    port: int = 22
    key: Path | None = None
    password: str | None = None
    sudo_password: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ClusterConfig:
    """Validated cluster configuration."""

    nodes: dict[str, NodeConfig]
    path: Path | None = None


def default_config_path() -> Path:
    """Resolve the config path using the PRD-defined precedence."""

    env_path = os.environ.get("TAPROOT_CONFIG")
    if env_path:
        return Path(env_path).expanduser()

    cwd_path = Path.cwd() / "nodes.yaml"
    if cwd_path.exists():
        return cwd_path

    return Path("~/.config/taproot/nodes.yaml").expanduser()


def load_config(path: str | Path | None = None, *, allow_empty_nodes: bool = False) -> ClusterConfig:
    """Load and validate nodes.yaml, merging defaults into each node."""

    config_path = Path(path).expanduser() if path is not None else default_config_path()
    if not config_path.exists():
        raise ConfigError(f"config file does not exist: {config_path}")

    try:
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"failed to parse YAML config {config_path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError("config root must be a mapping")

    defaults = raw.get("defaults") or {}
    nodes_raw = raw.get("nodes")
    if not isinstance(defaults, dict):
        raise ConfigError("defaults must be a mapping")
    if nodes_raw is None and allow_empty_nodes:
        nodes_raw = {}
    if not isinstance(nodes_raw, dict):
        raise ConfigError("nodes must be a mapping")
    if not nodes_raw and not allow_empty_nodes:
        raise ConfigError("nodes must be a non-empty mapping")

    nodes: dict[str, NodeConfig] = {}
    for node_name, node_data in nodes_raw.items():
        if not isinstance(node_name, str) or not node_name:
            raise ConfigError("node names must be non-empty strings")
        if not isinstance(node_data, dict):
            raise ConfigError(f"node {node_name} must be a mapping")
        merged = {**defaults, **node_data}
        nodes[node_name] = _build_node(node_name, merged)

    return ClusterConfig(nodes=nodes, path=config_path)


def _build_node(name: str, data: dict[str, Any]) -> NodeConfig:
    """Build one NodeConfig from merged raw data."""

    host = data.get("host")
    if not isinstance(host, str) or not host:
        raise ConfigError(f"node {name} requires a non-empty host")

    user = _optional_str(data, "user", name)
    password = _optional_str(data, "password", name)
    sudo_password = _optional_str(data, "sudo_password", name)

    port_raw = data.get("port", 22)
    try:
        port = int(port_raw)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"node {name} port must be an integer") from exc
    if port <= 0 or port > 65535:
        raise ConfigError(f"node {name} port must be in 1..65535")

    key: Path | None = None
    key_raw = data.get("key")
    if key_raw is not None:
        if not isinstance(key_raw, str) or not key_raw:
            raise ConfigError(f"node {name} key must be a non-empty string")
        key = Path(key_raw).expanduser()
        if not key.exists():
            raise ConfigError(f"node {name} key file does not exist: {key}")

    tags_raw = data.get("tags", [])
    if tags_raw is None:
        tags_raw = []
    if not isinstance(tags_raw, list) or not all(isinstance(tag, str) for tag in tags_raw):
        raise ConfigError(f"node {name} tags must be a list of strings")

    return NodeConfig(
        name=name,
        host=host,
        user=user,
        port=port,
        key=key,
        password=password,
        sudo_password=sudo_password,
        tags=list(tags_raw),
    )


def _optional_str(data: dict[str, Any], key: str, node_name: str) -> str | None:
    """Read an optional string field from raw node data."""

    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ConfigError(f"node {node_name} {key} must be a string")
    return value
