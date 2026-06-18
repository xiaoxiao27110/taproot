# taproot-mcp Test Flow

本目录是开发前先落地的测试流程，覆盖 PRD v0.1 与 v0.2 的关键验收场景。代码开发必须先让这些测试可运行，再按失败项迭代。

## 测试分层

1. 静态/单元测试
   - `test_config_targeting.py`: 校验 `nodes.yaml` defaults 合并、key 展开、错误提示、target 的 all/tag/glob/exact 解析。
   - `test_models_and_contract.py`: 校验统一返回信封、工具数量、工具 docstring 的 target 说明。
2. 本地 SSH 集成测试
   - `test_local_ssh_v01.py`: 使用 localhost SSH 模拟远端节点，覆盖 exec/read/write/edit/list/glob/upload/download/system_info 的主路径。
   - 不修改用户 SSH 配置；测试前请确认本机可执行 `ssh localhost true`。
3. tmux 会话集成测试
   - `test_local_tmux_v02.py`: 使用 localhost + tmux 验证 open/exec/read/interrupt/close/list，重点验证 `cd/export` 状态保留和 sentinel exit code。
4. Codex MCP 手动烟测
   - `codex/config-snippet.toml`: Codex MCP 配置示例。
   - `scripts/codex_smoke.md`: 在 Codex 中调用 taproot 工具的手动验收步骤。

## 快速运行

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[test]"
python -m pytest test-flow/tests/test_config_targeting.py test-flow/tests/test_models_and_contract.py
```

## localhost SSH 集成测试准备

1. 启用本机 SSH 服务。
   - macOS: System Settings -> General -> Sharing -> Remote Login。
   - Linux: 启动 `sshd`。
2. 确认当前用户可无交互登录：

```bash
ssh localhost true
```

如未配置 key，可先把当前公钥加入本机 `authorized_keys`：

```bash
mkdir -p ~/.ssh
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

也可以创建一把只用于本地测试的 dedicated key：

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/taproot_mcp_test_ed25519 -C 'taproot-mcp-local-test'
cat ~/.ssh/taproot_mcp_test_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/taproot_mcp_test_ed25519 ~/.ssh/authorized_keys
ssh-keyscan -T 3 localhost >> ~/.ssh/known_hosts
```

3. 复制测试配置并按需填写 `user` 或 `key`：

```bash
cp test-flow/fixtures/nodes.localhost.yaml /tmp/taproot-nodes.localhost.yaml
${EDITOR:-vi} /tmp/taproot-nodes.localhost.yaml
```

4. 运行集成测试：

```bash
TAPROOT_TEST_CONFIG=/tmp/taproot-nodes.localhost.yaml \
python -m pytest test-flow/tests/test_local_ssh_v01.py test-flow/tests/test_local_tmux_v02.py
```

## Codex MCP 烟测流程

1. 安装本地包：

```bash
python -m pip install -e .
taproot-mcp check --config /tmp/taproot-nodes.localhost.yaml
```

2. 按 `test-flow/codex/config-snippet.toml` 把 taproot 注册到 `~/.codex/config.toml`。
3. 在新的 Codex 会话里按 `test-flow/scripts/codex_smoke.md` 调用工具并记录结果。

## 验收判定

完成标准：

- 单元测试全部通过。
- localhost SSH 集成测试在可登录环境下全部通过。
- Codex 能发现 taproot MCP server，并能完成 `cluster_system_info`、`cluster_exec`、`cluster_write_file/read_file/edit_file`、`cluster_session_open/exec/close` 的烟测。
- 故意配置一个不可达节点时，工具调用仍返回统一信封，失败只出现在对应节点条目中。
