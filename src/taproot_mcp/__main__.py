"""Command-line entrypoint for taproot-mcp."""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Sequence

from taproot_mcp.config import ConfigError, load_config
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
        return _serve(namespace.config, namespace.transport, namespace.host, namespace.port)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
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

    return parser


def _serve(config_path: str | None, transport: str, host: str, port: int) -> int:
    """Start the MCP server with the selected transport."""

    config = load_config(config_path)
    tools = TaprootTools(config)
    server = build_mcp_server(tools, host=host, port=port)
    server.run(transport="streamable-http" if transport == "http" else "stdio")
    return 0


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
