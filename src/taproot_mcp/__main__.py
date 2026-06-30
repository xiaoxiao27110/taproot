"""Command-line entrypoint for taproot-mcp."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Sequence

from taproot_mcp.approvals import CLI_APPROVAL_ENV, ApprovalError, ApprovalStore
from taproot_mcp.config import ConfigError, load_config
from taproot_mcp.history import read_history
from taproot_mcp.server import TaprootTools, build_mcp_server
from taproot_mcp.ssh_pool import SSHPool


def main(argv: Sequence[str] | None = None) -> int:
    """Run the taproot-mcp command."""

    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        args = ["serve"]
    elif args[0].startswith("-") and args[0] not in {"-h", "--help"}:
        args = ["serve", *args]

    parser = _build_parser()
    namespace = parser.parse_args(args)

    try:
        if namespace.command == "check":
            return asyncio.run(_check(namespace.config, namespace.timeout))
        if namespace.command == "validate":
            return _validate(namespace.config, namespace.require_nodes)
        if namespace.command == "history":
            return _history(namespace.config, namespace.node, namespace.limit)
        if namespace.command == "approvals":
            return _approvals(namespace)
        return _serve(namespace.config, namespace.transport, namespace.host, namespace.port)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2
    except ApprovalError as exc:
        print(f"approval error: {exc}", file=sys.stderr)
        return 2


def _build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser."""

    parser = argparse.ArgumentParser(prog="taproot-mcp")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="start the MCP server")
    serve.add_argument("--config", help="path to nodes.yaml")
    serve.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="MCP transport to use",
    )
    serve.add_argument("--host", default="127.0.0.1", help="HTTP bind host")
    serve.add_argument("--port", type=int, default=8000, help="HTTP bind port")

    check = subparsers.add_parser("check", help="validate config and SSH connectivity")
    check.add_argument("--config", help="path to nodes.yaml")
    check.add_argument("--timeout", type=float, default=10.0, help="per-node SSH timeout")

    validate = subparsers.add_parser("validate", help="validate config without SSH connectivity")
    validate.add_argument("--config", help="path to nodes.yaml")
    validate.add_argument(
        "--require-nodes",
        action="store_true",
        help="reject configs with no configured nodes",
    )

    history = subparsers.add_parser("history", help="print recent MCP operation history")
    history.add_argument("--config", help="path to nodes.yaml")
    history.add_argument("--node", help="only include one node")
    history.add_argument("--limit", type=int, default=100, help="maximum events to print")

    approvals = subparsers.add_parser("approvals", help="manage pending operation approvals")
    approval_subparsers = approvals.add_subparsers(dest="approval_command", required=True)

    approvals_list = approval_subparsers.add_parser("list", help="list approvals")
    approvals_list.add_argument("--config", help="path to nodes.yaml")
    approvals_list.add_argument(
        "--status",
        choices=["pending", "approved", "remembered", "rejected", "consumed"],
        help="only show approvals with this status",
    )

    approvals_approve = approval_subparsers.add_parser("approve", help="approve one pending operation")
    approvals_approve.add_argument("--config", help="path to nodes.yaml")
    approvals_approve.add_argument("id", help="approval id")

    approvals_remember = approval_subparsers.add_parser(
        "remember",
        help="remember one pending operation for matching future requests",
    )
    approvals_remember.add_argument("--config", help="path to nodes.yaml")
    approvals_remember.add_argument("id", help="approval id")

    approvals_reject = approval_subparsers.add_parser("reject", help="reject one pending operation")
    approvals_reject.add_argument("--config", help="path to nodes.yaml")
    approvals_reject.add_argument("id", help="approval id")

    return parser


def _serve(config_path: str | None, transport: str, host: str, port: int) -> int:
    """Start the MCP server with the selected transport."""

    config = load_config(config_path, allow_empty_nodes=True)
    tools = TaprootTools(config)
    server = build_mcp_server(tools, host=host, port=port)
    server.run(transport="streamable-http" if transport == "http" else "stdio")
    return 0


def _validate(config_path: str | None, require_nodes: bool) -> int:
    """Validate config shape without opening SSH connections."""

    config = load_config(config_path, allow_empty_nodes=not require_nodes)
    print(f"config ok: {len(config.nodes)} node(s)")
    return 0


def _history(config_path: str | None, node: str | None, limit: int) -> int:
    """Print recent MCP operation history as JSON."""

    config = load_config(config_path)
    print(json.dumps(read_history(config, node=node, limit=max(1, limit)), ensure_ascii=False))
    return 0


def _approvals(namespace: argparse.Namespace) -> int:
    """Manage local approval records."""

    config = load_config(namespace.config)
    store = ApprovalStore(config)
    if namespace.approval_command == "list":
        payload = store.list(status=namespace.status)
    elif namespace.approval_command == "approve":
        _require_cli_approval_enabled()
        payload = store.approve(namespace.id)
    elif namespace.approval_command == "remember":
        _require_cli_approval_enabled()
        payload = store.remember(namespace.id)
    elif namespace.approval_command == "reject":
        _require_cli_approval_enabled()
        payload = store.reject(namespace.id)
    else:
        raise ApprovalError(f"unknown approvals command: {namespace.approval_command}")
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _require_cli_approval_enabled() -> None:
    """Require an explicit opt-in before mutating approvals from the CLI."""

    if os.environ.get(CLI_APPROVAL_ENV) != "1":
        raise ApprovalError(
            f"CLI approval changes are disabled by default; use the Taproot dashboard "
            f"or set {CLI_APPROVAL_ENV}=1 for an explicit local override"
        )


async def _check(config_path: str | None, timeout: float) -> int:
    """Run SSH connectivity checks for all configured nodes."""

    config = load_config(config_path)
    pool = SSHPool(config, connect_timeout=timeout)
    try:
        failures = 0
        for node_name in config.nodes:
            ok, detail = await pool.check_node(node_name)
            if ok:
                print(f"{node_name}: ok")
            else:
                failures += 1
                print(f"{node_name}: failed - {detail}")
        return 1 if failures else 0
    finally:
        await pool.close()


if __name__ == "__main__":
    raise SystemExit(main())
