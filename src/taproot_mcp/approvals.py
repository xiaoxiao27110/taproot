"""Local approval queue for high-risk Taproot operations."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from taproot_mcp.config import ClusterConfig


APPROVALS_FILE = "approvals.json"
SENSITIVE_KEYS = {"password", "sudo_password", "content", "old_str", "new_str"}


class ApprovalError(ValueError):
    """Raised when an approval record cannot be updated."""


def state_dir(config: ClusterConfig) -> Path:
    """Return the local Taproot state directory associated with a config."""

    if config.path is not None:
        return config.path.parent / ".taproot"
    return Path("~/.config/taproot").expanduser()


def approval_path(config: ClusterConfig) -> Path:
    """Return the local approval queue path associated with a config."""

    return state_dir(config) / APPROVALS_FILE


class ApprovalStore:
    """Small JSON-backed approval store."""

    def __init__(self, config: ClusterConfig) -> None:
        self.config = config
        self.path = approval_path(config)

    def request(self, tool: str, target: str, details: dict[str, Any]) -> dict[str, Any]:
        """Return an existing pending approval or create a new one."""

        op_hash = operation_hash(tool, target, details)
        records = self._read()
        for record in records:
            if record.get("op_hash") == op_hash and record.get("status") == "pending":
                return record

        now = _now()
        record = {
            "id": uuid.uuid4().hex[:12],
            "op_hash": op_hash,
            "status": "pending",
            "tool": tool,
            "target": target,
            "details": _safe_details(details),
            "created_at": now,
            "updated_at": now,
        }
        records.append(record)
        self._write(records)
        return record

    def consume(self, tool: str, target: str, details: dict[str, Any]) -> dict[str, Any] | None:
        """Consume one approved matching approval, if present."""

        op_hash = operation_hash(tool, target, details)
        records = self._read()
        for record in records:
            if record.get("op_hash") == op_hash and record.get("status") == "approved":
                record["status"] = "consumed"
                record["consumed_at"] = _now()
                record["updated_at"] = record["consumed_at"]
                self._write(records)
                return record
        return None

    def list(self, status: str | None = None) -> list[dict[str, Any]]:
        """List approval records, newest first."""

        records = self._read()
        if status:
            records = [record for record in records if record.get("status") == status]
        return sorted(records, key=lambda item: str(item.get("created_at", "")), reverse=True)

    def approve(self, approval_id: str) -> dict[str, Any]:
        """Mark a pending approval as approved."""

        return self._set_status(approval_id, "approved")

    def reject(self, approval_id: str) -> dict[str, Any]:
        """Mark a pending approval as rejected."""

        return self._set_status(approval_id, "rejected")

    def _set_status(self, approval_id: str, status: str) -> dict[str, Any]:
        records = self._read()
        for record in records:
            if record.get("id") != approval_id:
                continue
            current = record.get("status")
            if current != "pending":
                raise ApprovalError(
                    f"approval {approval_id} is {current}; only pending approvals can be {status}"
                )
            record["status"] = status
            record[f"{status}_at"] = _now()
            record["updated_at"] = record[f"{status}_at"]
            self._write(records)
            return record
        raise ApprovalError(f"approval not found: {approval_id}")

    def _read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict)]

    def _write(self, records: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.path)


def operation_hash(tool: str, target: str, details: dict[str, Any]) -> str:
    """Return a stable hash for one approval-sensitive operation."""

    payload = {
        "tool": tool,
        "target": target,
        "details": _safe_details(details),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _safe_details(details: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in details.items():
        if key in SENSITIVE_KEYS:
            continue
        safe[key] = value
    return safe


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
