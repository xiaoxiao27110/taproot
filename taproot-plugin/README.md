# Taproot VS Code Extension

Visual `nodes.yaml` editor and connection dashboard for `taproot-mcp`.

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
python -m pip install -e ..
```

If the command lives elsewhere, set `taproot.taprootMcpCommand`.

## Settings

- `taproot.configPath`: Path to `nodes.yaml`. Empty uses workspace `nodes.yaml`, then `~/.config/taproot/nodes.yaml`.
- `taproot.taprootMcpCommand`: Command used for `taproot-mcp check`.
