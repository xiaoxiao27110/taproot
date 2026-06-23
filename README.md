# Taproot

[简体中文](README.zh-CN.md)

Taproot is a local fleet-level MCP server for SSH-managed clusters, with an optional VS Code dashboard for editing `nodes.yaml` and checking node connectivity.

The GitHub project is `taproot`, the Python package is `taproot-mcp`, and the VS Code extension is `Taproot MCP` / `taproot-mcp`.

`taproot-mcp` runs on the same machine as Codex or Claude Code, exposes a fixed set of cluster tools over MCP, and reaches each configured node through SSH.

Remote nodes do not need taproot installed. They only need SSH access.

## Install

From PyPI:

```bash
python -m pip install taproot-mcp
```

For local development:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

After installation, the command entrypoint is available:

```bash
taproot-mcp --help
```

## Configuration

Config lookup order:

1. `TAPROOT_CONFIG`
2. `./nodes.yaml`
3. `~/.config/taproot/nodes.yaml`

Example:

```yaml
defaults:
  user: admin
  key: ~/.ssh/id_rsa
  port: 22

nodes:
  gpu-node-1:
    host: 192.168.1.101
    tags: [gpu, h200, vllm]
  dev-vm:
    host: 192.168.1.200
    user: dev
    tags: [dev, build]
```

`password` and `sudo_password` are supported for convenience, but they are stored in plaintext. Treat them with the same care as any other secret file.

Taproot does not collect telemetry. Keep `nodes.yaml`, `.taproot/`, history files, approval files, SSH keys, and VSIX build outputs out of source control.

## VS Code Extension

The VS Code extension is a client UI for this package. It does not bundle the Python MCP server.

Install `taproot-mcp` first so the `taproot-mcp` command is available on `PATH`:

```bash
python -m pip install taproot-mcp
```

Then install the `Taproot MCP` extension from VS Code Marketplace. If the command is installed in a non-standard location, set the extension setting `taproot.taprootMcpCommand`.

## Check Nodes

Before registering the MCP server with an agent, validate config and SSH connectivity:

```bash
taproot-mcp check --config ./nodes.yaml
```

## Run Server

Stdio is the default transport:

```bash
taproot-mcp serve --config ./nodes.yaml
```

Streamable HTTP is available for clients that need an HTTP endpoint:

```bash
taproot-mcp serve --config ./nodes.yaml --transport http --host 127.0.0.1 --port 8765
```

## Codex Registration

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.taproot]
command = "taproot-mcp"
args = ["serve", "--config", "/absolute/path/to/nodes.yaml"]
env = {}
```

## Claude Code Registration

```bash
claude mcp add taproot -- taproot-mcp serve --config /absolute/path/to/nodes.yaml
```

For HTTP transport:

```bash
taproot-mcp serve --config /absolute/path/to/nodes.yaml --transport http --port 8765
claude mcp add --transport http taproot http://localhost:8765/mcp
```

## Tools

Discovery:

- `cluster_nodes` returns the current node inventory from the running MCP server. MCP clients should use this instead of reading `nodes.yaml` directly.

v0.1 stateless broadcast tools:

- `cluster_exec`
- `cluster_read_file`
- `cluster_edit_file`
- `cluster_write_file`
- `cluster_list_dir`
- `cluster_glob`
- `cluster_system_info`
- `cluster_service`
- `cluster_upload`
- `cluster_download`

v0.2 single-node tmux session tools:

- `cluster_session_open`
- `cluster_session_exec`
- `cluster_session_read`
- `cluster_session_interrupt`
- `cluster_session_close`
- `cluster_session_list`

All node-targeted tools return the same envelope shape:

```json
{
  "results": {
    "gpu-node-1": {"ok": true},
    "gpu-node-2": {"ok": false, "error": "connection refused"}
  },
  "summary": {"success": 1, "failed": 1, "total": 2}
}
```

Single-node targets use the same envelope with one result entry.

## Remote Safety Policy

Taproot enforces remote permissions on the MCP server side. Local agent sandbox
settings do not grant extra access on remote nodes.

- Remote file paths are resolved against the SSH user's physical `$HOME`.
  Relative paths and `~/...` stay inside that home directory by default.
- Home-internal file tools run without approval, except protected directories
  such as `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, and
  `~/.taproot`.
- Paths outside home, `sudo=True`, `cluster_exec`, service mutations, and
  `cluster_session_exec` require CLI approval before execution.
- Pending approvals are stored beside the active config in `.taproot/approvals.json`.

Approve or reject high-risk operations from a separate terminal:

```bash
taproot-mcp approvals list --config ./nodes.yaml --status pending
taproot-mcp approvals approve <approval-id> --config ./nodes.yaml
taproot-mcp approvals reject <approval-id> --config ./nodes.yaml
```

Backups for write/edit/upload operations are centralized on each remote node:

```text
~/.taproot/backups/<path_sha256>/<local-utc-timestamp>--<basename>
```

Taproot uses the MCP server's UTC clock for backup filenames and prunes backups
per original path to the newest 300 entries and entries no older than 30 days.

## Operation History

Every node-targeted MCP tool call appends per-node JSONL events to:

```text
<nodes.yaml directory>/.taproot/history.jsonl
```

The history excludes password fields. `cluster_write_file` stores a bounded write-content preview for UI inspection. Inspect history with:

```bash
taproot-mcp history --config ./nodes.yaml --node gpu-node-1 --limit 50
```

## Tests

The project test flow lives in `test-flow/`:

```bash
python -m pip install -e ".[test]"
python -m pytest
```

Local SSH/tmux integration tests are skipped unless `TAPROOT_TEST_CONFIG` is set. See `test-flow/README.md`.
