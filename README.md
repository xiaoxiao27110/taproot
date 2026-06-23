# Taproot

[简体中文](README.zh-CN.md)

Taproot is a local MCP server for SSH-managed nodes. Agents use `taproot-mcp serve`; the VS Code extension is the control panel for editing node config and checking status.

Remote nodes only need SSH access. They do not need Taproot installed.

## Quick Start

### 1. Install `taproot-mcp`

Install it on the same machine where the MCP server will run. For VS Code Remote-SSH, install it on the SSH remote host.

```bash
python -m pip install taproot-mcp
taproot-mcp --help
```

### 2. Install the VS Code extension

Install `taproot-mcp` from the VS Code Marketplace.

For Remote-SSH, make sure the extension is installed under `SSH: <host>`, not `Local`.

Usually no extension setting is needed after `python -m pip install taproot-mcp`.

If the Taproot panel says `taproot-mcp` is unavailable, set `taproot.taprootMcpCommand` to the full path of the installed command. This is only needed when VS Code cannot see the same `PATH` as your terminal.

### 3. Add nodes

Open the Taproot panel in VS Code, add your SSH nodes, then run the connection check from the panel.

You can also check from a terminal:

```bash
taproot-mcp check --config /absolute/path/to/nodes.yaml
```

### 4. Start the local MCP server

In VS Code, press `Ctrl+Shift+P` (`Command+Shift+P` on macOS), type `taproot`, and click **Start Local MCP Server**.

In your agent's MCP settings, use this server URL:

```text
http://localhost:8765/mcp
```

The server runs on the same local machine as your agent and manages remote nodes through SSH.

## Agent Examples

Manual server start, without the VS Code button:

```bash
taproot-mcp serve --config /absolute/path/to/nodes.yaml --transport http --host 127.0.0.1 --port 8765
```

Claude Code HTTP:

```bash
claude mcp add --transport http taproot http://localhost:8765/mcp
```

### Stdio Alternative

For MCP clients that launch servers by command, use stdio instead of a long-running HTTP server.

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.taproot]
command = "taproot-mcp"
args = ["serve", "--config", "/absolute/path/to/nodes.yaml"]
env = {}
```

Claude Code stdio:

```bash
claude mcp add taproot -- taproot-mcp serve --config /absolute/path/to/nodes.yaml
```

## `nodes.yaml`

Example:

```yaml
defaults:
  user: admin
  key: ~/.ssh/id_rsa
  port: 22

nodes:
  gpu-node-1:
    host: 192.168.1.101
    tags: [gpu, vllm]
  dev-vm:
    host: 192.168.1.200
    user: dev
    tags: [dev, build]
```

Config lookup order:

1. `TAPROOT_CONFIG`
2. `./nodes.yaml`
3. `~/.config/taproot/nodes.yaml`

## Tools

Discovery:

- `cluster_nodes`

Broadcast tools:

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

Single-node tmux session tools:

- `cluster_session_open`
- `cluster_session_exec`
- `cluster_session_read`
- `cluster_session_interrupt`
- `cluster_session_close`
- `cluster_session_list`

## Safety

- `password` and `sudo_password` in `nodes.yaml` are plaintext. Prefer SSH keys.
- Do not commit `nodes.yaml`, `.taproot/`, history files, approval files, SSH keys, or VSIX files.
- Taproot enforces remote permissions on the MCP server side.
- Home-internal file tools run without approval, except protected directories such as `~/.ssh`, `~/.aws`, `~/.kube`, and `~/.taproot`.
- Paths outside home, `sudo=True`, command execution, service mutations, and tmux command execution require CLI approval.

Approve or reject pending operations:

```bash
taproot-mcp approvals list --config /absolute/path/to/nodes.yaml --status pending
taproot-mcp approvals approve <approval-id> --config /absolute/path/to/nodes.yaml
taproot-mcp approvals reject <approval-id> --config /absolute/path/to/nodes.yaml
```

## Development

```bash
python -m pip install -e ".[test]"
python -m pytest
```

VS Code extension:

```bash
cd taproot-plugin
npm install
npm test
```
