"""Persistent operation history for taproot MCP tool calls."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from taproot_mcp.config import ClusterConfig


SENSITIVE_KEYS = {"password", "sudo_password", "old_str", "new_str"}
MAX_CONTENT_PREVIEW = 4000


def default_history_path(config: ClusterConfig) -> Path:
    """Return the JSONL history path associated with one cluster config."""

    if config.path is not None:
        return config.path.parent / ".taproot" / "history.jsonl"
    return Path("~/.config/taproot/history.jsonl").expanduser()


def append_tool_history(
    config: ClusterConfig,
    tool: str,
    target: str,
    details: dict[str, Any],
    envelope: dict[str, Any],
) -> None:
    """Append one history event per node result, ignoring logging failures."""

    path = default_history_path(config)
    timestamp = datetime.now(timezone.utc).isoformat()
    safe_details = _safe_details(details)
    default_risk = _safe_risk(details.get("_risk"))
    events = []
    for node, result in envelope.get("results", {}).items():
        if node not in config.nodes:
            continue
        ok = result.get("ok") is True
        detail = dict(safe_details)
        if result.get("backup_path"):
            detail["backup_path"] = result["backup_path"]
        event = {
            "id": uuid.uuid4().hex,
            "timestamp": timestamp,
            "node": node,
            "tool": tool,
            "target": target,
            "ok": ok,
            "action": _action_for_tool(tool),
            "summary": _summary_for_tool(tool, safe_details),
            "detail": detail,
        }
        risk = _safe_risk(result.get("risk")) or default_risk
        if risk is not None:
            event["risk"] = risk
        if not ok and result.get("error"):
            event["error"] = str(result["error"])
        events.append(event)

    if not events:
        return

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    except OSError:
        return


def read_history(
    config: ClusterConfig,
    node: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Read recent operation history, newest first."""

    path = default_history_path(config)
    if not path.exists():
        return []

    events: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if node and event.get("node") != node:
            continue
        events.append(event)
        if len(events) >= limit:
            break
    return events


def _safe_details(details: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in details.items():
        if key.startswith("_") or key == "risk":
            continue
        if key in SENSITIVE_KEYS:
            continue
        if key == "content":
            preview = str(value)
            safe["content_preview"] = preview[:MAX_CONTENT_PREVIEW]
            safe["content_truncated"] = len(preview) > MAX_CONTENT_PREVIEW
            continue
        safe[key] = value
    return safe


def _safe_risk(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    level = value.get("level")
    if level not in {"warning", "danger"}:
        return None
    label = str(value.get("label") or ("高风险" if level == "danger" else "需留意"))
    raw_reasons = value.get("reasons")
    reasons = [str(item) for item in raw_reasons if item] if isinstance(raw_reasons, list) else []
    raw_context = value.get("context")
    context = _safe_details(raw_context) if isinstance(raw_context, dict) else {}
    return {
        "level": level,
        "label": label,
        "reasons": reasons,
        "context": context,
    }


def _action_for_tool(tool: str) -> str:
    return {
        "cluster_exec": "exec",
        "cluster_read_file": "read",
        "cluster_edit_file": "edit",
        "cluster_write_file": "write",
        "cluster_list_dir": "list",
        "cluster_glob": "glob",
        "cluster_system_info": "system",
        "cluster_service": "service",
        "cluster_upload": "upload",
        "cluster_download": "download",
        "cluster_session_open": "session",
        "cluster_session_exec": "exec",
        "cluster_session_read": "read",
        "cluster_session_interrupt": "interrupt",
        "cluster_session_close": "session",
    }.get(tool, "operation")


def _summary_for_tool(tool: str, details: dict[str, Any]) -> str:
    if tool == "cluster_exec":
        return f"执行 bash: {details.get('command', '')}".strip()
    if tool == "cluster_edit_file":
        return f"编辑文件: {details.get('path', '')}".strip()
    if tool == "cluster_write_file":
        return f"写入文件: {details.get('path', '')}".strip()
    if tool == "cluster_read_file":
        return f"读取文件: {details.get('path', '')}".strip()
    if tool == "cluster_upload":
        return f"上传文件: {details.get('local_path', '')} -> {details.get('remote_path', '')}".strip()
    if tool == "cluster_download":
        return f"下载文件: {details.get('remote_path', '')} -> {details.get('local_path', '')}".strip()
    if tool == "cluster_list_dir":
        return f"列目录: {details.get('path', '')}".strip()
    if tool == "cluster_glob":
        return f"查找文件: {details.get('pattern', '')}".strip()
    if tool == "cluster_service":
        return f"服务 {details.get('action', '')}: {details.get('service', '')}".strip()
    if tool == "cluster_system_info":
        return "读取系统信息"
    if tool.startswith("cluster_session_"):
        return tool.removeprefix("cluster_").replace("_", " ")
    return tool
