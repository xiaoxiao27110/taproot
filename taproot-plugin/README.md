# Taproot VS Code Extension

Visual `nodes.yaml` editor and connection dashboard for `taproot-mcp`.

This extension is the VS Code client for the Taproot project:

https://github.com/xiaoxiao27110/taproot

The extension does not bundle the Python MCP server. Install `taproot-mcp` before using connection checks.

## Features

- Edit defaults and node overrides for `nodes.yaml`.
- Add/delete nodes and tags.
- Save the YAML config while preserving fields not shown in the UI, such as `key`.
- Run `taproot-mcp check` from the extension to test node connectivity.
- Open a VS Code terminal with the selected node's SSH command.
- Copy SSH commands from the detail page or context menu.

## Requirements

Install the Python package first so `taproot-mcp` is available on `PATH`:

```bash
python -m pip install taproot-mcp
```

If the command lives elsewhere, set `taproot.taprootMcpCommand`.

For local development from this repository:

```bash
python -m pip install -e ..
```

## Settings

- `taproot.configPath`: Path to `nodes.yaml`. Empty uses workspace `nodes.yaml`, then `~/.config/taproot/nodes.yaml`.
- `taproot.taprootMcpCommand`: Command used for `taproot-mcp check`.

## Privacy and Security

- The extension does not collect telemetry.
- `password` and `sudo_password` values in `nodes.yaml` are stored in plaintext.
- Prefer SSH keys when possible.
- Do not commit `nodes.yaml`, `.taproot/`, history files, approval records, SSH keys, or VSIX files.
