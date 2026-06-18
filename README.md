# taproot-mcp

`taproot-mcp` is a local fleet-level MCP server. It runs on the same machine as Codex or Claude Code, exposes a fixed set of cluster tools over MCP, and reaches each configured node through SSH.

Remote nodes do not need taproot installed. They only need SSH access.

## Install

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

## Tests

The project test flow lives in `test-flow/`:

```bash
python -m pip install -e ".[test]"
python -m pytest
```

Local SSH/tmux integration tests are skipped unless `TAPROOT_TEST_CONFIG` is set. See `test-flow/README.md`.
