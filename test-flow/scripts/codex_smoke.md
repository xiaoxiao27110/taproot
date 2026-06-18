# Codex MCP Smoke Test

在新的 Codex 会话中确认 taproot 工具可见，并依次执行以下请求。

1. 查看所有本地测试节点：

```text
用 taproot 的 cluster_system_info 查看 target="all"
```

期望：返回 `local-vllm` 与 `local-build` 两个 results 条目，summary total 为 2。

2. 验证 tag target：

```text
用 taproot 的 cluster_exec 在 target="tag:vllm" 上执行 command="printf vllm"
```

期望：只返回 `local-vllm`。

3. 验证无状态 exec：

```text
先用 cluster_exec 在 local-vllm 执行 "cd /tmp"，再执行 "pwd"
```

期望：第二次 `pwd` 不依赖第一次 `cd`，证明 v0.1 exec 不保留 shell 状态。

4. 验证文件工具：

```text
在 local-vllm 的 /tmp/taproot-codex-smoke.txt 写入 "port: 8080"，读取它，再把 "port: 8080" edit 成 "port: 8081"
```

期望：write/read/edit 都返回统一信封且 ok=true。
