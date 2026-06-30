# taproot-mcp

VS Code control panel for Taproot: configure SSH nodes, check status, and prepare the shared HTTP MCP backend that your agent connects to.

## Quick Start

### 1. Install this extension

Install `taproot-mcp` from the VS Code Marketplace.

For Remote-SSH, install it under `SSH: <host>`, not `Local`.

Taproot runs on the same machine as the agent that connects to it. In a Remote-SSH VS Code window, extension commands run on the SSH host, and Codex must connect to that same host's Taproot HTTP endpoint.

### 2. Copy the setup prompt into your agent

Click **Copy Agent Prompt** in the Taproot panel or Command Palette, then paste it into your agent tool.

The prompt asks the agent to install or update `taproot-mcp`, start the local HTTP MCP server for the first time, and connect the agent to that server in one flow. The extension no longer runs backend installation scripts itself.

If `~/.config/taproot/nodes.yaml` does not exist yet, save your node config from the Taproot panel before the first backend start. The extension no longer auto-creates `nodes.yaml`.

### 3. Add nodes

Open the Taproot panel, add your SSH nodes, then run the connection check from the panel.

### 4. Shared HTTP backend

```text
http://127.0.0.1:8765/mcp
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.taproot]
url = "http://127.0.0.1:8765/mcp"
```

In a Remote-SSH VS Code window, this `127.0.0.1` is the SSH host where the extension runs, not your desktop shell.

Claude Code:

```bash
claude mcp add --transport http taproot http://127.0.0.1:8765/mcp
```

Codex should connect to the HTTP server started from this extension. It should not launch a separate `taproot-mcp` subprocess.

### Other Clients

For MCP clients that launch servers by command, stdio is still available. Codex should keep using the HTTP URL above.

```bash
claude mcp add taproot -- taproot-mcp serve --config /absolute/path/to/nodes.yaml
```

## Settings

- `taproot.configPath`: Path to `nodes.yaml`. Empty uses `~/.config/taproot/nodes.yaml`.
- `taproot.taprootMcpCommand`: Command used for `taproot-mcp validate`, `check`, and `serve`.

## Security

- The extension does not collect telemetry.
- `password` and `sudo_password` values in `nodes.yaml` are plaintext. Prefer SSH keys.
- Do not commit `nodes.yaml`, `.taproot/`, history files, approval records, SSH keys, or VSIX files.
