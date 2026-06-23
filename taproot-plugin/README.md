# taproot-mcp

VS Code control panel for Taproot: configure SSH nodes, check status, and use the same `nodes.yaml` with agent-side MCP servers.

## Quick Start

### 1. Install this extension

Install `taproot-mcp` from the VS Code Marketplace.

For Remote-SSH, install it under `SSH: <host>`, not `Local`.

Open the Taproot panel and click **Install/Update Backend**.

Taproot runs on the same machine as the agent that connects to it. In a Remote-SSH VS Code window, extension commands run on the SSH host.

### 2. Add nodes

Open the Taproot panel, add your SSH nodes, then run the connection check from the panel.

### 3. Start the local MCP server

In the Taproot side bar or Command Palette, click **Start Local MCP Server**.

### 4. Connect your agent

```text
http://localhost:8765/mcp
```

Claude Code:

```bash
claude mcp add --transport http taproot http://localhost:8765/mcp
```

## Agent Examples

Manual server start, without the VS Code button:

```bash
taproot-mcp serve --config /absolute/path/to/nodes.yaml --transport http --host 127.0.0.1 --port 8765
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

## Settings

- `taproot.configPath`: Path to `nodes.yaml`. Empty uses workspace `nodes.yaml`, then `~/.config/taproot/nodes.yaml`.
- `taproot.taprootMcpCommand`: Command used for `taproot-mcp check`.
- `taproot.pythonCommand`: Python command used by **Install/Update Backend**. Empty auto-detects Python.

## Security

- The extension does not collect telemetry.
- `password` and `sudo_password` values in `nodes.yaml` are plaintext. Prefer SSH keys.
- Do not commit `nodes.yaml`, `.taproot/`, history files, approval records, SSH keys, or VSIX files.
