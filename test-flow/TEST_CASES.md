# Taproot 联调用例说明

本文档定义 Taproot 前后端联调要覆盖的测试环境、测试用例、执行方式和通过标准。目标是让后续自动化测试实现可以直接按本说明拆分用例，不再临时决定测什么。

## 1. 总体验收目标

联调通过需要同时满足以下条件：

- 10 个 Docker SSH 节点可以一键启动、生成测试专用 `nodes.yaml`，并在测试后清理。
- 后端 MCP 的 17 个工具全部覆盖正常、异常、广播/部分失败、权限拦截场景。
- 高风险操作必须先返回 `approval_required`，批准后只放行一次，拒绝后不得执行远端动作。
- MCP stdio 和 HTTP transport 都能完成工具发现、工具调用和 `taproot://nodes` resource 读取。
- VS Code 插件能完成配置读写、节点连接检查、状态展示、历史展示、终端/复制 SSH 入口。
- approval、history、前端状态、测试日志、容器日志都不得泄露 password、sudo_password、私钥、完整写入内容或 edit 字符串。
- 所有结果都使用统一 envelope；单节点失败不得导致整个广播工具调用崩溃。

## 2. Docker 测试节点矩阵

| 节点 | 端口 | 角色 | 标签 | 关键能力 |
| --- | --- | --- | --- | --- |
| `node-01-basic` | `22201` | 标准健康节点 | `healthy,gpu,vllm` | SSH key auth、tmux、fake GPU、sudo 密码正确 |
| `node-02-build` | `22202` | 构建节点 | `healthy,build` | password auth、tmux、NOPASSWD sudo、无 GPU |
| `node-03-slow` | `22203` | 慢节点 | `slow,vllm` | 慢命令、timeout、长输出、大文件 |
| `node-04-perms` | `22204` | 权限节点 | `perms` | protected home path、outside-home、permission denied |
| `node-05-service` | `22205` | 服务节点 | `service` | fake `systemctl` active/inactive/failure |
| `node-06-files` | `22206` | 文件节点 | `files` | 嵌套目录、重复字符串、二进制样本、glob 截断 |
| `node-07-no-tmux` | `22207` | 无 tmux 节点 | `no-tmux` | SSH 正常，但没有 tmux |
| `node-08-bad-sudo` | `22208` | sudo 失败节点 | `bad-sudo` | SSH 正常，但配置的 sudo 密码错误 |
| `node-09-bad-auth` | `22209` | 认证失败节点 | `bad-auth` | sshd 正常，`nodes.yaml` 写入错误凭证 |
| `node-10-down` | `22210` | 不可达节点 | `down` | 端口存在配置，但无可用 sshd |

通过标准：

- `cluster_nodes` 返回 10 个节点。
- `target="all"` 总数为 10。
- `target="tag:vllm"` 命中 `node-01-basic` 和 `node-03-slow`。
- `target="node-0*"` 命中全部 10 个节点。
- bad-auth/down 只影响对应节点 result，不影响健康节点。

## 3. 后端工具测试用例

### TC-BE-001 `cluster_nodes` 节点清单

前置条件：Docker 节点已启动，测试配置已生成。

步骤：

1. 调用 `cluster_nodes`。
2. 检查返回节点、标签、host、port、auth 字段。
3. 检查返回内容中没有 key/password/sudo_password 实际值。
4. 修改测试配置中的一个 tag，再次调用 `cluster_nodes`。

通过标准：

- 返回 10 个节点，节点顺序与配置顺序一致。
- `auth.key`、`auth.password`、`auth.sudo_password` 只暴露布尔值。
- 配置变更后运行时 reload 生效。

### TC-BE-010 `cluster_exec` 基础执行和目标解析

步骤：

1. exact target 调用 `printf ok`。
2. tag target 调用 `hostname`。
3. wildcard target 调用 `printf wildcard`。
4. all target 调用 `printf all`。

通过标准：

- 正常节点 `stdout`、`stderr`、`exit_code` 正确。
- all target 的 `summary.total=10`。
- bad-auth/down 为失败 result，健康节点成功。

### TC-BE-011 `cluster_exec` 无状态与 `cwd`

步骤：

1. 在 `node-01-basic` 执行 `cd /tmp`。
2. 再执行 `pwd`。
3. 使用 `cwd="/tmp"` 执行 `pwd`。

通过标准：

- 第二步输出不是 `/tmp`，证明无状态。
- 第三步输出 `/tmp`，证明 `cwd` 生效。

### TC-BE-012 `cluster_exec` timeout、非零退出和 sudo

步骤：

1. 在 `node-03-slow` 执行 `sleep 5`，timeout 设为 1。
2. 执行 `sh -c 'exit 7'`。
3. 在 `node-01-basic` 执行 sudo 命令。
4. 在 `node-08-bad-sudo` 执行 sudo 命令。

通过标准：

- timeout 只让对应节点失败。
- 非零退出仍是 `ok=true`，`exit_code=7`。
- sudo 命令首次触发 approval。
- approval 后 good sudo 成功，bad sudo 失败且 envelope 正确。

### TC-BE-020 `cluster_read_file`

步骤：

1. 读取 home 内普通文本文件。
2. 读取不存在文件。
3. 读取目录路径。
4. 读取超过 1 MiB 的文件。
5. 读取 `/etc/passwd`。
6. 读取 `~/.ssh/authorized_keys`。

通过标准：

- home 内文本返回 `content` 和 `size`。
- 不存在、目录、大文件返回对应错误。
- `/etc/passwd` 触发 approval。
- `~/.ssh/authorized_keys` 直接 denied，不创建 approval。

### TC-BE-030 `cluster_write_file`

步骤：

1. 写入新文件。
2. 覆盖已有文件并启用 backup。
3. 写入空字符串。
4. 写入超过 4000 字符内容。
5. 写入 outside-home 路径。
6. 写入 protected home path。

通过标准：

- 新文件和空文件写入成功。
- 覆盖已有文件返回 `backup_path`，路径位于 `~/.taproot/backups/`。
- history 只记录 `content_preview`，并设置 `content_truncated=true`。
- outside-home 触发 approval。
- protected path 直接 denied。

### TC-BE-040 `cluster_edit_file`

步骤：

1. old_str 恰好出现一次，执行替换。
2. old_str 出现 0 次。
3. old_str 出现多次。
4. backup=false 执行替换。
5. sudo 编辑 outside-home 文件。
6. 在 bad-sudo 节点执行 sudo edit。

通过标准：

- 唯一匹配时 `changed=true`。
- 0 次返回 `old_str was not found`。
- 多次返回 `old_str is not unique`。
- backup=false 不返回 backup_path。
- sudo/outside-home 必须先 approval。
- bad-sudo approval 后执行失败。

### TC-BE-050 `cluster_list_dir`

步骤：

1. 列普通目录。
2. 列空目录。
3. path 指向文件。
4. path 不存在。
5. 列 outside-home 目录。
6. 列 protected home path。

通过标准：

- entries 包含 `name`、`type`、`size`。
- 文件/不存在路径返回失败 result。
- outside-home 触发 approval。
- protected path 直接 denied。

### TC-BE-060 `cluster_glob`

步骤：

1. 默认 `path="~"` 查找 `*.yaml`。
2. 指定目录查找 `*.conf`。
3. 查找无匹配 pattern。
4. 在 node-06-files 生成超过 200 个匹配。
5. outside-home 查找。
6. protected path 查找。

通过标准：

- matches 包含 `path`、`size`、`modified`。
- 无匹配返回空列表且成功。
- 超过 200 条设置 `truncated=true`。
- outside-home 触发 approval。
- protected path denied。

### TC-BE-070 `cluster_system_info`

步骤：

1. 在 fake GPU 节点调用。
2. 在无 GPU 节点调用。
3. 在 malformed JSON fixture 节点调用。
4. all target 调用。

通过标准：

- GPU 节点返回非空 `gpus`。
- 无 GPU 节点返回 `gpus=[]`。
- malformed JSON 节点失败且错误可读。
- all target 中 bad-auth/down 只影响对应节点。

### TC-BE-080 `cluster_service`

步骤：

1. 调用 `status` 查看 active 服务。
2. 调用 `status` 查看 inactive 服务。
3. 调用 `start`。
4. 调用 `stop`。
5. 调用 `restart`。
6. 调用非法 action。
7. 在 bad-sudo 节点调用 mutation。

通过标准：

- `status` 不触发 approval。
- start/stop/restart 首次触发 approval。
- approve 后 fake systemctl 状态变化正确。
- 非法 action 抛明确错误。
- bad-sudo approval 后执行失败。

### TC-BE-090 `cluster_upload`

步骤：

1. 上传单文件。
2. 上传目录。
3. 设置 mode。
4. 重复上传相同内容。
5. 传入不存在 local_path。
6. 传入非法 mode。
7. sudo 上传 outside-home。
8. 制造 move/chmod 失败后检查 tmp 清理。

通过标准：

- 返回 `remote_path`、`bytes`、`sha256`。
- 目录上传返回 `files`。
- 重复上传返回 `skipped=true`。
- 不存在 local_path 和非法 mode 返回明确错误。
- sudo/outside-home 触发 approval。
- 失败后没有残留 `/tmp/taproot-upload-*`。

### TC-BE-100 `cluster_download`

步骤：

1. 单节点下载文件到具体路径。
2. 单节点下载文件到目录。
3. 多节点下载同名文件。
4. 下载目录。
5. 下载不存在 remote path。
6. 下载 outside-home path。
7. 下载 protected home path。

通过标准：

- 本地文件存在，sha256 正确。
- 多节点写入 `local_path/<node>/<basename>`，互不覆盖。
- 目录下载返回 `files`。
- outside-home 触发 approval。
- protected path denied。

### TC-BE-110 session 工具

覆盖工具：

- `cluster_session_open`
- `cluster_session_exec`
- `cluster_session_read`
- `cluster_session_interrupt`
- `cluster_session_close`
- `cluster_session_list`

步骤：

1. 在 `node-01-basic` 打开 session。
2. 在 `node-07-no-tmux` 打开 session。
3. 对未知 node 打开 session。
4. session_exec 首次执行 `cd /tmp && export TAPROOT_SESSION_TEST=ok`。
5. approve 后再次执行。
6. 执行 `pwd; printf "$TAPROOT_SESSION_TEST"`。
7. 执行 `sh -c 'exit 7'`。
8. 执行长循环并设置短 timeout。
9. read 读取输出。
10. interrupt 中断长任务。
11. list 检查 session。
12. close 关闭 session。
13. close 后再次 read/close。

通过标准：

- open 成功返回 `session_id` 和 `tmux_session`。
- no-tmux 和 unknown node 返回失败 envelope。
- session_exec 必须先 approval。
- cwd/env 在 session 内保留。
- exit_code 解析正确。
- timeout 后 read 能看到输出，interrupt 成功。
- close 后远端 tmux 被清理，再次操作失败。

## 4. Approval 权限测试用例

### TC-APP-001 approval 生命周期

步骤：

1. 触发一次 `cluster_exec`。
2. 读取 pending approval。
3. 重复触发相同操作。
4. approve。
5. 再次触发相同操作。
6. 再触发第三次相同操作。
7. reject 一个 pending approval。
8. reject 后再次触发。

通过标准：

- 第一次创建 pending。
- 第二次复用同一个 pending id。
- approve 后下一次执行成功且 approval 状态变 consumed。
- consumed 不可复用，第三次重新需要 approval。
- reject 后不执行远端动作。
- reject 后再次触发产生新的 pending。

### TC-APP-002 approval 触发面

必须覆盖：

- `cluster_exec`
- `cluster_service` start/stop/restart
- `cluster_session_exec`
- 文件工具 sudo=true
- 文件工具 outside-home read/write/list/glob/upload/download

通过标准：

- 上述场景全部返回 `approval_required=true`。
- protected home path 不走 approval，而是直接 denied。

### TC-APP-003 approval 脱敏

步骤：

1. 使用包含 password、sudo_password、content、old_str、new_str 的操作触发 approval。
2. 调 CLI `taproot-mcp approvals list`。
3. 扫描 approval JSON。

通过标准：

- approval details 不包含敏感字段。
- approval error 中不包含密码或完整写入内容。

## 5. History 测试用例

### TC-HIST-001 history 记录

步骤：

1. 每类工具至少执行一次成功用例。
2. 每类工具至少执行一次失败用例。
3. 调 `taproot-mcp history --limit 200`。

通过标准：

- 每个真实节点 result 追加一条 JSONL。
- synthetic `unknown` session result 不写入节点 history。
- 成功事件 `ok=true`，失败事件 `ok=false` 且带 error。

### TC-HIST-002 history 容错和脱敏

步骤：

1. 手动插入坏 JSONL 行。
2. 写入超过 4000 字符内容。
3. 执行 edit 操作。
4. 执行带 sudo_password 的操作。

通过标准：

- 坏 JSONL 不导致 CLI 失败。
- write_file 只保存 content preview。
- edit 不保存 old_str/new_str。
- 不保存 sudo_password。

## 6. MCP 协议测试用例

### TC-MCP-001 stdio transport

步骤：

1. 启动 `taproot-mcp serve --config test-flow/.runtime/nodes.docker.yaml`。
2. MCP initialize。
3. tools/list。
4. resources/list。
5. tools/call 调用代表工具。
6. resources/read 读取 `taproot://nodes`。

通过标准：

- tools/list 正好包含 17 个工具。
- resource 可读取且 JSON 有效。
- 调用结果是统一 envelope。
- 进程可以被干净关闭。

### TC-MCP-002 HTTP transport

步骤：

1. 启动 HTTP transport 到临时端口。
2. initialize。
3. tools/list。
4. tools/call。
5. resource read。
6. 关闭 server。

通过标准：

- HTTP 响应 JSON 有效。
- stateless HTTP 多次调用互不污染。
- resource 不泄露 secret。

## 7. CLI 测试用例

### TC-CLI-001 check

步骤：

1. 对 Docker 配置执行 `taproot-mcp check`。
2. 对只包含健康节点的临时配置执行 check。
3. 对包含 bad-auth/down 的配置执行 check。

通过标准：

- 全健康配置 exit code 为 0。
- 含失败节点配置 exit code 为 1。
- 输出包含 `<node>: ok` 或 `<node>: failed - <reason>`。

### TC-CLI-002 配置错误

输入：

- 配置文件不存在
- YAML 语法错误
- root 不是 mapping
- nodes 为空
- host 缺失
- port 非数字
- port 超范围
- key 文件不存在

通过标准：

- exit code 为 2。
- stderr 以 `config error:` 开头。
- 错误信息指向具体字段。

## 8. VS Code 插件测试用例

### TC-FE-001 extension host

步骤：

1. 使用临时 workspace 启动 VS Code extension test。
2. 设置 `taproot.configPath` 指向 Docker 测试配置。
3. 禁用自动轮询。
4. 激活扩展。
5. 执行 contributed commands。

通过标准：

- 扩展可激活。
- 命令全部注册。
- tree view 可以展示节点。
- 无测试数据写入用户真实配置。

### TC-FE-002 连接检查

步骤：

1. 执行 `taproot.testConnections`。
2. mock `taproot-mcp check` 正常输出。
3. mock partial output。
4. mock timeout。
5. mock spawn error。

通过标准：

- 健康节点显示 online。
- 失败节点显示 error 和原因。
- partial output 中缺失节点显示“未返回连接结果”。
- timeout/spawn error 通过 error message 展示。

### TC-FE-003 Webview 消息

覆盖消息：

- `ready`
- `state`
- `statusUpdate`
- `validation`
- `error`
- `testResults`
- `saved`
- `toast`
- `selectNode`
- `showConfig`

通过标准：

- UI 状态更新正确。
- silent statusUpdate 不弹成功 toast。
- validation/error 显示错误 toast。
- selectNode 后详情区定位到对应节点。
- showConfig 切换到配置页。

### TC-FE-004 配置编辑器

步骤：

1. 添加节点。
2. 删除节点。
3. 修改 host/user/port/password/sudo_password。
4. 添加/删除 tag。
5. 输入重复节点名。
6. 输入空 host。
7. 输入非法 port。
8. 保存。
9. reset。

通过标准：

- YAML 序列化符合后端配置格式。
- extra 字段被保留。
- 重复名、空 host、非法 port 显示 validation。
- reset 重新读取磁盘状态。

### TC-FE-005 活动历史展示

步骤：

1. 后端生成成功和失败 history。
2. 扩展加载 history。
3. 切换到节点详情。
4. 展开活动项。
5. 查看写入内容 preview。

通过标准：

- 活动按节点分组。
- 失败项明显标识。
- 展开后显示 error/detail。
- 写入内容只显示 preview，不显示被截断的全文。

### TC-FE-006 终端和复制 SSH

步骤：

1. 对 key auth 节点执行 copy SSH。
2. 对 password auth 节点执行 open terminal。
3. mock sshpass 可用。
4. mock expect 可用。
5. mock 两者都不可用。

通过标准：

- clipboard 写入正确 SSH 命令。
- 终端命令正确。
- password 不直接拼进可见命令。
- 无 sshpass/expect 时提示需要手动输入。

## 9. 安全拦截测试

### TC-SEC-001 secret leak scan

步骤：

1. 在测试配置中使用固定 secret sentinel。
2. 执行全量测试。
3. 扫描以下位置：
   - pytest output
   - Docker logs
   - container command log
   - approval JSON
   - history JSONL
   - frontend mock state dump
   - generated artifacts

通过标准：

- 不出现 password sentinel。
- 不出现 sudo_password sentinel。
- 不出现 private key 内容。
- 不出现完整 large content。
- 不出现 old_str/new_str。

### TC-SEC-002 remote command intercept

步骤：

1. 容器侧记录 SSH command。
2. 执行 sudo 命令。
3. 执行 upload 失败场景。
4. 检查 command log 和 tmp 目录。

通过标准：

- sudo password 不出现在命令行。
- sudo password 不出现在容器日志。
- upload 失败后 tmp 文件清理。

## 10. 一键执行通过标准

完整命令：

```bash
test-flow/scripts/run-all.sh
```

通过标准：

- Docker 节点启动成功。
- 测试配置生成成功。
- Python unit/contract 通过。
- Docker backend integration 通过。
- MCP stdio/http smoke 通过。
- VS Code plugin test 通过。
- secret leak scan 通过。
- cleanup 成功，无残留容器和测试进程。

调试命令：

```bash
TAPROOT_TEST_KEEP=1 test-flow/scripts/run-all.sh
```

通过标准：

- 测试失败时保留 `test-flow/.runtime/`。
- README 中能根据 runtime logs 定位失败节点和失败工具。
