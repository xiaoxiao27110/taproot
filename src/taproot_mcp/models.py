"""Shared result envelope models."""

from __future__ import annotations

from typing import Any

from typing_extensions import TypedDict


class Summary(TypedDict):
    """Summary counts for a tool result envelope."""

    success: int
    failed: int
    total: int


class NodeResult(TypedDict, total=False):
    """Per-node tool result."""

    ok: bool
    error: str


class Envelope(TypedDict):
    """Uniform result envelope returned by all tools."""

    results: dict[str, dict[str, Any]]
    summary: Summary


def make_envelope(results: dict[str, dict[str, Any]]) -> Envelope:
    """Build the uniform tool result envelope from per-node results."""

    success = sum(1 for item in results.values() if item.get("ok") is True)
    failed = sum(1 for item in results.values() if item.get("ok") is False)
    return {
        "results": results,
        "summary": {"success": success, "failed": failed, "total": len(results)},
    }


def ok_result(**fields: Any) -> dict[str, Any]:
    """Build a successful per-node result."""

    return {"ok": True, **fields}


def error_result(error: str, **fields: Any) -> dict[str, Any]:
    """Build a failed per-node result."""

    return {"ok": False, "error": error, **fields}
