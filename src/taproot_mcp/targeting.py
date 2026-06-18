"""Resolve fleet target strings into node names."""

from __future__ import annotations

import fnmatch
from collections.abc import Mapping

from taproot_mcp.config import NodeConfig


class TargetError(ValueError):
    """Raised when a target string cannot be resolved."""


def resolve_target(target: str, nodes: Mapping[str, NodeConfig]) -> list[str]:
    """Resolve all/tag/glob/exact target strings into ordered node names."""

    if not isinstance(target, str) or not target:
        raise TargetError("target must be a non-empty string")

    available = list(nodes.keys())
    if target == "all":
        return available

    if target.startswith("tag:"):
        tag = target.removeprefix("tag:")
        if not tag:
            raise TargetError("tag target must be formatted as tag:<name>")
        matches = [name for name, node in nodes.items() if tag in node.tags]
        if not matches:
            raise TargetError(f"{target} has no matching nodes")
        return matches

    if "*" in target or "?" in target:
        matches = [name for name in available if fnmatch.fnmatchcase(name, target)]
        if not matches:
            raise TargetError(f"{target} has no matching nodes")
        return matches

    if target not in nodes:
        joined = ", ".join(available) if available else "(none)"
        raise TargetError(f"{target} is not a configured node; available nodes: {joined}")

    return [target]
