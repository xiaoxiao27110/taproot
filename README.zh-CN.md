# Taproot

[English](README.md)

Taproot 是一个运行在本地的 fleet-level MCP server，用于通过 SSH 管理集群节点；同时提供可选的 VS Code dashboard，用来编辑 `nodes.yaml`、检查节点连接状态，并为你的 agent 准备同一个 HTTP MCP backend。

GitHub 项目名是 `taproot`，Python 包名是 `taproot-mcp`，VS Code 扩展名是 `taproot-mcp` / `taproot-mcp`。

`taproot-mcp` 运行在本地机器上，通过 MCP 暴露固定的一组集群工具，并通过 SSH 连接每个配置好的节点。对于 Codex，约定是连接 VS Code 插件启动的 HTTP MCP server，而不是让 Codex 自己再拉起一个 `taproot-mcp` 进程。

远端节点不需要安装 Taproot，只需要可 SSH 登录。

## 安装

从 PyPI 安装：

```bash
python -m pip install taproot-mcp
```

本地开发安装：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

安装后会得到命令行入口：

```bash
taproot-mcp --help
```

## 配置

配置文件查找顺序：

1. `TAPROOT_CONFIG`
2. `./nodes.yaml`
3. `~/.config/taproot/nodes.yaml`

示例：

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

`password` 和 `sudo_password` 可以为了方便写入配置，但它们是明文存储。请把它们当作任何其他密钥文件一样保护。

Taproot 不收集 telemetry。不要把 `nodes.yaml`、`.taproot/`、history 文件、approval 文件、SSH key 或 VSIX 构建产物提交到源码仓库。

## VS Code 扩展

VS Code 扩展是这个包的客户端 UI，并内置可交给 Agent 安装的 Python backend wheel。

推荐使用流程：

1. 从商店安装 `taproot-mcp` 插件。
2. 点击 **Copy Agent Prompt**，把提示词粘贴到你的 agent 工具里。
3. 让 Agent 按提示词完成后端安装/更新、第一次启动 HTTP MCP server，并把自己连接到这个 server。

扩展不再直接运行后端安装脚本；安装、启动和 MCP 连接由你粘贴给 Agent 的提示词一次性完成。

也可以手动安装 `taproot-mcp`，确保 `taproot-mcp` 命令在 `PATH` 中：

```bash
python -m pip install taproot-mcp
```

如果命令安装在非标准路径，可以设置扩展配置项 `taproot.taprootMcpCommand`。

## 检查节点

把 MCP server 注册给 agent 前，先验证配置和 SSH 连通性：

```bash
taproot-mcp check --config ./nodes.yaml
```

只校验 YAML schema、不连接 SSH：

```bash
taproot-mcp validate --config ./nodes.yaml
```

## 运行 Server

默认 transport 是 stdio：

```bash
taproot-mcp serve --config ./nodes.yaml
```

需要 HTTP endpoint 的客户端可以使用 Streamable HTTP：

```bash
taproot-mcp serve --config ./nodes.yaml --transport http --host 127.0.0.1 --port 8765
```

`serve` 可以在 `nodes: {}` 为空时启动；执行 SSH 操作或连接检查前仍需要添加节点。

## Codex 注册

通过插件点击 **Copy Agent Prompt** 是主流程。如果你需要手动配置，也可以把下面内容加入 `~/.codex/config.toml`：

```toml
[mcp_servers.taproot]
url = "http://127.0.0.1:8765/mcp"
```

如果是 VS Code Remote-SSH 窗口，这里的 `127.0.0.1` 指的是运行 Taproot 扩展的 SSH host，不是你桌面本机的 shell。

## Claude Code 注册

```bash
claude mcp add taproot -- taproot-mcp serve --config /absolute/path/to/nodes.yaml
```

HTTP transport：

```bash
taproot-mcp serve --config /absolute/path/to/nodes.yaml --transport http --port 8765
claude mcp add --transport http taproot http://127.0.0.1:8765/mcp
```

Codex 只连接这个 HTTP endpoint，不单独拉起 `taproot-mcp` 子进程。

## 工具

发现工具：

- `cluster_nodes` 返回当前 MCP server 加载的节点清单。MCP client 应使用这个工具发现节点，而不是直接读取 `nodes.yaml`。

v0.1 无状态广播工具：

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

v0.2 单节点 tmux 会话工具：

- `cluster_session_open`
- `cluster_session_exec`
- `cluster_session_read`
- `cluster_session_interrupt`
- `cluster_session_close`
- `cluster_session_list`

所有面向节点的工具都返回同一种 envelope：

```json
{
  "results": {
    "gpu-node-1": {"ok": true},
    "gpu-node-2": {"ok": false, "error": "connection refused"}
  },
  "summary": {"success": 1, "failed": 1, "total": 2}
}
```

单节点 target 也使用同样结构，只是 `results` 中只有一个节点条目。

## 远程安全策略

Taproot 在 MCP server 侧执行远程权限控制。本地 agent 的 sandbox 设置不会给远端节点额外授权。

- 远程文件路径按 SSH 用户的物理 `$HOME` 解析。相对路径和 `~/...` 默认限制在该 home 目录内。
- home 内部文件工具默认不需要 approval，但 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.docker`、`~/.taproot` 等受保护目录除外。
- home 外路径、`sudo=True`、`cluster_exec`、service 变更和 `cluster_session_exec` 都需要 Taproot approval 后才会执行。
- VS Code dashboard 对待审批危险操作提供三个选择：允许一次、允许并记住匹配的后续请求、拒绝。
- “允许并记住”匹配同一目标和保守规范化后的操作指纹。对于 shell 命令，目前只把空白差异视为同一请求。
- CLI 修改 approval 默认禁用，避免 MCP client 按错误提示执行命令后自己审批自己。只有明确需要本地 override 时才设置 `TAPROOT_ENABLE_CLI_APPROVAL=1`。
- 待审批记录存储在当前配置旁边的 `.taproot/approvals.json`。

在终端中查看待审批操作：

```bash
taproot-mcp approvals list --config ./nodes.yaml --status pending
```

approval 队列是本地状态，不是对同一系统用户、且拥有任意 shell/文件写入能力 agent 的密码学隔离边界。

写入、编辑、上传操作的备份集中存放在每个远端节点：

```text
~/.taproot/backups/<path_sha256>/<local-utc-timestamp>--<basename>
```

Taproot 使用 MCP server 的 UTC 时钟生成备份文件名，并按原始路径保留最新 300 份且不超过 30 天的备份。

## 操作历史

每次面向节点的 MCP 工具调用都会为每个节点追加 JSONL 事件到：

```text
<nodes.yaml directory>/.taproot/history.jsonl
```

历史记录会排除 password 字段。`cluster_write_file` 会保存有限长度的写入内容预览，便于 UI 检查。查看历史：

```bash
taproot-mcp history --config ./nodes.yaml --node gpu-node-1 --limit 50
```

## 测试

项目测试流程在 `test-flow/`：

```bash
python -m pip install -e ".[test]"
python -m pytest
```

本地 SSH/tmux 集成测试默认跳过，除非设置了 `TAPROOT_TEST_CONFIG`。详见 `test-flow/README.md`。
