# Taproot

[简体中文](README.zh-CN.md)

Taproot is a local MCP server for SSH-managed nodes. The VS Code extension is the control panel for editing `nodes.yaml`, checking status, and preparing the shared HTTP MCP backend that your agent connects to.

Remote nodes only need SSH access. They do not need Taproot installed.

## Quick Start

### 1. Install the VS Code extension

Install `taproot-mcp` from the VS Code Marketplace.

For Remote-SSH, install it under `SSH: <host>`, not `Local`.

Taproot runs on the same machine as the agent that connects to it. In a Remote-SSH VS Code window, extension commands run on the SSH host, and Codex must connect to that same host's Taproot HTTP endpoint.

CLI-only install, without VS Code:

```bash
python -m pip install https://github.com/xiaoxiao27110/taproot/releases/download/v0.2.2/taproot_mcp-0.2.2-py3-none-any.whl
```

### 2. Copy the setup prompt into your agent

Click **Copy Agent Prompt** in the Taproot panel or Command Palette, then paste it into your agent tool.

The prompt asks the agent to install or update `taproot-mcp`, start the local HTTP MCP server for the first time, and connect the agent to that server in one flow. The extension no longer runs backend installation scripts itself.

### 3. Add nodes

Open the Taproot panel in VS Code, add your SSH nodes, then run the connection check from the panel.

You can also check from a terminal:

```bash
taproot-mcp check --config /absolute/path/to/nodes.yaml
```

### 4. Shared HTTP backend

```text
http://127.0.0.1:8765/mcp
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.taproot]
url = "http://127.0.0.1:8765/mcp"
```

In a Remote-SSH VS Code window, this `127.0.0.1` is the SSH host where the Taproot extension runs, not your desktop shell.

Claude Code:

```bash
claude mcp add --transport http taproot http://127.0.0.1:8765/mcp
```

Codex should connect to the HTTP server started from the Taproot VS Code extension. It should not launch a separate `taproot-mcp` subprocess.

If you need to start the server manually, the command is still available:

```bash
taproot-mcp serve --config /absolute/path/to/nodes.yaml --transport http --host 127.0.0.1 --port 8765
```

### Other Clients

For MCP clients that launch servers by command, stdio is still available. Codex should keep using the HTTP URL above.

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
- Home-internal file tools run without extra prompts, except protected directories such as `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, and `~/.taproot`, which are denied.
- Paths outside home, `sudo=True`, service mutations, tmux command execution, and clearly dangerous shell commands are executed but recorded with risk metadata in history.
- The VS Code dashboard highlights risky history entries instead of blocking for approval.
- Legacy approval files and CLI commands may still exist for compatibility, but they are not part of the normal execution path.

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
