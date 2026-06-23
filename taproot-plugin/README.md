# taproot-mcp

VS Code control panel for Taproot: configure SSH nodes, check status, and use the same `nodes.yaml` with agent-side MCP servers.

## Quick Start

### 1. Install `taproot-mcp`

Install the Python package in the same environment where this extension runs. For Remote-SSH, install it on the SSH remote host.

```bash
python -m pip install taproot-mcp
taproot-mcp --help
```

### 2. Install this extension

Install `taproot-mcp` from the VS Code Marketplace.

For Remote-SSH, make sure it is installed under `SSH: <host>`, not `Local`.

Usually no extension setting is needed after `python -m pip install taproot-mcp`.

If the Taproot panel says `taproot-mcp` is unavailable, set `taproot.taprootMcpCommand` to the full path of the installed command. This is only needed when VS Code cannot see the same `PATH` as your terminal.

### 3. Add nodes

Open the Taproot panel, add your SSH nodes, then run the connection check from the panel.

### 4. Start the local MCP server

In the Taproot panel, click **Start Local MCP Server**.

In your agent's MCP settings, use this server URL:

```text
http://localhost:8765/mcp
```

The server runs on the same local machine as your agent and manages remote nodes through SSH.

## Agent Examples

Claude Code HTTP:

```bash
claude mcp add --transport http taproot http://localhost:8765/mcp
```

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

## Security

- The extension does not collect telemetry.
- `password` and `sudo_password` values in `nodes.yaml` are plaintext. Prefer SSH keys.
- Do not commit `nodes.yaml`, `.taproot/`, history files, approval records, SSH keys, or VSIX files.
