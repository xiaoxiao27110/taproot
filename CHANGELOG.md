# Changelog

All notable changes to Taproot are documented here.

## 0.2.1 - 2026-06-23

- Added a VS Code **Install/Update Backend** command and panel button for installing `taproot-mcp`.
- Added VS Code extension commands to start and stop the local HTTP MCP server.
- Fixed Remote-SSH extension placement by running the extension on the workspace side.
- Simplified README and Marketplace quick start instructions.
- Added first-use `nodes.yaml` initialization in the VS Code extension.

## 0.2.0 - 2026-06-23

- Added tmux-backed single-node session tools for persistent shell workflows.
- Added remote safety approvals, protected path handling, backups, and operation history.
- Added the taproot-mcp extension for editing `nodes.yaml`, checking connections, and opening SSH terminals.
- Added package metadata and CI/release scaffolding for open source and Marketplace publishing.

## 0.1.0

- Added the initial fleet-level MCP server with stateless broadcast tools over SSH.
- Added node targeting by exact name, glob, tag, and `all`.
- Added the shared per-node result envelope used by all node-targeted tools.
