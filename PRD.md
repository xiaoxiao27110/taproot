
# taproot-mcp 开发规格说明

> 这是一份交给编码 agent(Codex)执行的项目规格。请严格按照本文档实现,尤其注意"范围边界"一节。本文档覆盖  **v0.1** (无状态、可广播的核心工具,第 1–13 节)与  **v0.2** (基于 tmux 的有状态会话,第 14 节)。先做v0.1再做v0.2 交付时应完成两版，用git commit 隔开**;但实现 v0.1 时不要在架构上堵死 v0.2。**

---

## 1. 项目目标

构建一个  **fleet-level(集群级)MCP server** ,名为 `taproot-mcp`。

它的核心理念是:**一个入口,穿透集群里的每一台机器,操作如同操作单机。**

### 部署模型

 **taproot-mcp 运行在你的本地机器上** (即运行 VS Code 插件 / Codex / Claude Code 的那台电脑)。当前产品约定里，Codex 连接的是 VS Code 插件启动的 Streamable HTTP server；Claude Code 或其他命令式客户端仍可直接用 stdio。它不是一个部署在远端服务器上的中心化服务——它就是你笔记本/工作站上的一个本地进程。

```
┌─ 你的本地机器 ──────────────────────────────┐
│                                              │
│  Codex                                      │
│       ↕ HTTP(MCP 协议)                      │
│  VS Code Taproot 插件启动的 taproot-mcp      │
│       ↕ SSH(asyncssh 连接池)                │
│       ├──→ 远端节点 A                        │
│       ├──→ 远端节点 B                        │
│       └──→ 远端节点 C                        │
│                                              │
│  Claude Code / 其他客户端                    │
│       ↕ stdio 或 HTTP(MCP 协议)              │
│  taproot-mcp (同机本地进程)                  │
│       ↕ SSH(asyncssh 连接池)                │
│       ├──→ 远端节点 A                        │
│       ├──→ 远端节点 B                        │
│       └──→ 远端节点 C                        │
│                                              │
└──────────────────────────────────────────────┘
```

所有 SSH 连接从本地机器发出,指向远端节点。工具参数中的 `local_path`(upload/download)指的就是这台本地机器上的路径。远端节点上 **不需要安装任何 taproot 组件** ——唯一前提是开了 SSH。

与市面上常见的 SSH MCP server 不同——那些是 **node-level** 的(agent 先选一台机器,再对它执行命令,N 台机器就是 N 个 server 或 N 组重复工具)。taproot 是 **fleet-level** 的: **一个 MCP server 管理 N 台机器** ,agent 看到的是一组固定的、集群级的工具,机器数量体现为工具参数的取值,而不是工具数量的乘数。

这样做解决两个根本问题:

1. **context 污染** ——无论集群有 2 台还是 20 台机器,注册给 agent 的工具集恒定(与节点数无关,不随机器增多而膨胀),启动时注入 context 的工具定义体积不随节点数增长。
2. **跨机器认知断层** ——agent 不需要"SSH 进去再在远程 shell 里摸索",它调用的是结构化工具,传一个 `target` 参数指定操作范围,拿回结构化结果。

**本项目最重要的部分是接口设计(MCP tool definition),不是后端实现。** 工具的切分方式、参数 schema、description 文本、返回格式,直接决定 agent 用起来是否顺畅。后端(SSH 连接池、并行调度)是为这份接口服务的,可以随时替换;接口一旦定型,agent 的用法会围绕它固化,很难再改。请把实现精力的重心放在让这组工具的定义清晰、一致、自解释。

### 1.1 两类工具、会话连续性与版本边界

本项目的工具分为两个家族,服务两种根本不同的需求, **互不污染** :

* **无状态 · 可广播(v0.1)** :即第 7 节的工具(v0.1 共 10 个)。每次调用是独立、临时的纯函数——命令跑在一个全新的非交互 shell 里,执行完即结束(底层 TCP 连接被连接池复用,但 shell 状态不保留),`cd` / `export` / `source venv` 不跨调用持久。这正是 `target="all"` 能并行广播、能安全重试、且让 agent 推理最干净的前提:每个节点每条命令都是纯函数,不存在跨调用的共享可变状态。fleet 设计的核心价值(一次调用穿透所有机器)就建立在无状态之上。
* **有状态 · 单节点(v0.2)** :即第 14 节的 tmux 会话工具组。服务"多步依赖 cwd/env 的流程"和"想要一个活 shell / 流式输出"的少数场景。状态由**远端的常驻进程(tmux)**持有,而非由中心协调器维护——这是 VS Code Remote-SSH 的同款思路(远端有常驻 server 持有 PTY,所以状态持久)。有状态会话天然单节点(一台机器一份会话状态), **不广播** 。

**会话连续性要分清两层:**

1. **agent 层——有连续性,且与本 server 无关。** Codex/Claude Code 自身的 context window 提供记忆:每次工具调用的返回都回到 agent 上下文,所以 agent 记得之前调过什么、拿到什么,能"基于上一步结果决定下一步"(先 `cluster_system_info` 看到某节点显存满,再 `cluster_exec` 去查该节点进程)。这层连续性始终存在。
2. **远程执行层——v0.1 无状态(刻意如此),v0.2 由 tmux 提供持久状态。** 设计原则: **连续性放在 agent 层(它的记忆)+ 无状态工具,而不是放在工具层做有状态远程会话** ;只有少数确实需要持久 shell 的场景,才用 v0.2 的 tmux 会话补上。

**给实现者的硬约束:**

* v0.1 的 `cluster_exec`  **必须保持无状态** 。不要用常驻 `conn.run` 或后台 shell 让它"记住"上一条命令的 cwd/env;需要工作目录用 `cwd` 参数(见 7.1)。
* v0.2 的持久会话 **只用 tmux 实现** (tmux 即那个"常驻 server")。 **不要自建常驻 daemon、不要走 master-minion 重型分布式方案** ——那是被明确否决的路径(工程量是 Salt/kubelet 级别,不在本项目范围)。

---

## 2. 技术栈

* **语言** :Python ≥ 3.10
* **MCP** :官方 `mcp` Python SDK
* **SSH** :`asyncssh`(异步,原生支持 SFTP,适合连接池 + 并行)
* **配置解析** :`pyyaml`
* 无其他依赖。**不要**引入 SaltStack、Ansible、paramiko、fabric 等。

> ⚠️ `mcp` SDK 的 API 可能与你训练数据中的版本不同。实现前请查阅当前 SDK 文档,确认工具注册方式(FastMCP 装饰器风格 vs 低层 `Server` 类)、以及 stdio / Streamable HTTP 两种 transport 的当前启动方式,使用最新约定。

---

## 3. 项目结构

```
taproot-mcp/
  pyproject.toml
  README.md
  nodes.yaml.example
  src/taproot_mcp/
    __init__.py
    __main__.py        # 入口:参数解析、transport 选择、check 子命令
    server.py          # MCP server 实例 + 工具定义(v0.1 十个 + v0.2 会话工具)
    config.py          # 加载/校验 nodes.yaml,合并 defaults
    targeting.py       # 把 target 字符串解析成节点名列表
    ssh_pool.py        # asyncssh 连接池 + 各节点操作原语
    sessions.py        # (v0.2)tmux 会话管理:open/exec/read/interrupt/close
    models.py          # 返回信封的类型定义(TypedDict / dataclass)
```

---

## 4. 配置文件格式(nodes.yaml)

```yaml
# 全局默认值,可被单节点覆盖
defaults:
  user: admin
  key: ~/.ssh/id_rsa
  port: 22
  # sudo_password: "xxxx"   # 可选;节点 sudo 需要密码时填(也可写在单节点下)

nodes:
  gpu-node-1:
    host: 192.168.1.101
    tags: [gpu, h200, vllm]
  gpu-node-2:
    host: 192.168.1.102
    tags: [gpu, h200, vllm]
  dev-vm:
    host: 192.168.1.200
    user: dev              # 覆盖 defaults.user
    tags: [dev, build]
```

配置加载逻辑:

* 路径解析优先级:环境变量 `TAPROOT_CONFIG` → 当前目录 `./nodes.yaml` → `~/.config/taproot/nodes.yaml`。
* 每个节点的最终配置 = `defaults` 与该节点字段合并(节点字段优先)。
* `key` 支持 `~` 展开。也允许节点用 `password` 字段(明文,仅 v0.1 便利用途,README 中标注安全风险)。
* `sudo_password`(可选,defaults 或单节点): **仅供 server 内部向 `sudo -S` 注入,绝不作为工具参数、绝不经过 agent** ;明文存储,与 `password` 同等对待其安全风险。
* 启动时校验:节点名唯一、`host` 必填、key 文件存在(若用 key)。校验失败给出清晰报错并退出。

请提供 `nodes.yaml.example` 作为模板。

---

## 5. target 解析规则

`target` 是所有工具共用的、决定操作范围的参数。它是 **单个字符串** (不是数组),按以下规则解析成节点名列表:

| target 形式                  | 含义       | 解析                                                   |
| ---------------------------- | ---------- | ------------------------------------------------------ |
| `"all"`                    | 所有节点   | 返回全部节点名                                         |
| `"tag:vllm"`               | 标签过滤   | 返回 tags 包含 `vllm`的所有节点                      |
| `"gpu-*"`/`"gpu-node-?"` | 通配符     | 用 `fnmatch`对节点名匹配(含 `*`或 `?`时走此分支) |
| `"gpu-node-1"`             | 精确节点名 | 匹配单个节点                                           |

* 精确名未找到 → 报错,提示该节点不存在并列出可用节点名。
* 通配符 / tag 匹配到 0 个节点 → 报错,说明无匹配。
* 选择单字符串而非数组的理由:LLM 处理单一字符串参数比处理数组或多参数组合更可靠,`target="all"` 这种近自然语言写法对 LLM 几乎零认知成本。**请勿改成数组形式。**

把这套解析逻辑独立放在 `targeting.py`,便于单元测试。

---

## 6. 统一返回格式(关键设计)

**所有工具,无论 target 匹配到 1 个还是 N 个节点,都返回同一种信封结构。** 这样 agent 的解析逻辑与 target 无关,始终一致:

```json
{
  "results": {
    "gpu-node-1": { "ok": true,  /* ...工具特定字段... */ },
    "gpu-node-2": { "ok": true,  /* ... */ },
    "gpu-node-3": { "ok": false, "error": "connection refused" }
  },
  "summary": { "success": 2, "failed": 1, "total": 3 }
}
```

* 每个节点条目必有 `ok: bool`。
* `ok: false` 时必有 `error: str`(人类可读的失败原因),不再带工具特定字段。
* `ok: true` 时带该工具的成功字段(见下一节各工具定义)。
* `summary` 让 agent 不必遍历所有结果就能判断整体状态:先看 summary,有 `failed` 再去 results 里定位具体节点。这能减少 agent 的推理步骤。
* **单节点 target 也用这个结构** (results 里只有一个条目),不要为单节点设计一个扁平的特殊返回。

在 `models.py` 用 TypedDict 把信封类型固定下来。

---

## 7. 工具定义(项目核心)

实现以下 10 个工具(均为 v0.1)。

下面每个工具给出函数签名、description(即 docstring——注意这是面向 LLM 的 prompt,不是面向人的文档,务必把 target 语法用例子写进去)、行为说明、成功字段。

### 7.1 `cluster_exec`

```python
async def cluster_exec(target: str, command: str, cwd: str | None = None, sudo: bool = False, sudo_password: str | None = None, timeout: int = 30) -> dict
```

**description(docstring,中文):**

```
在集群节点上执行 shell 命令(无状态:每次在全新 shell 中执行,cd/export 不跨调用保留)。

target 指定执行范围:
- 单节点: "gpu-node-1"
- 通配符: "gpu-*"
- 按标签: "tag:vllm"
- 全部节点: "all"

cwd:可选工作目录,命令将在该目录下执行。
需要激活环境时,把 source 写进 command 即可,例如:
"source /opt/vllm/venv/bin/activate && python -c 'import vllm'"。

sudo=True:以 root 执行该命令(用于安装、写系统目录等)。
sudo_password 可选:不传则用该节点 nodes.yaml 里配的密码(主路径);
传了则临时覆盖(便利入口)。两者皆无则按 NOPASSWD 处理。

广播到多个节点时会并行执行。返回每个匹配节点的 stdout、stderr、exit_code。
```

* 提供 `cwd` 时,实际执行 `cd <shlex.quote(cwd)> && <command>`(用 `shlex.quote` 处理含空格/特殊字符的路径);`cwd` 不破坏无状态性,也不破坏并行。
* 通过 `conn.run(...)` 执行;`cwd` 缺省时直接执行原命令。
* `sudo=True` 时执行 `sudo -S -p '' <command>`,密码经 stdin 注入(`conn.run(..., input=pw)`)。密码优先级:`pw = sudo_password 参数 or 该节点配置的 sudo_password`,两者皆空则依赖 NOPASSWD。广播时各节点自动用各自配置的密码。
* 成功字段:`stdout: str`、`stderr: str`、`exit_code: int`。
* 命令超时按该节点的失败处理(`ok: false`, error 说明超时),不影响其他节点。
* **保持无状态** :不要为了"记住 cwd"而维护常驻 shell——cwd 每次显式传入。

### 7.2 `cluster_read_file`

```python
async def cluster_read_file(target: str, path: str) -> dict
```

**description:**

```
读取集群节点上的文件内容。

target 语法同 cluster_exec(单节点/通配符/tag:/all)。
通过 SFTP 读取,返回文件文本内容。适合读配置、日志片段等。
```

* **用 SFTP 读取** (`conn.start_sftp_client()`),不要用 `cat` 走 shell——避免转义和二进制问题。
* 成功字段:`content: str`、`size: int`(字节数)。
* 对超大文件可设一个合理上限(如 1 MB),超限时 `ok: false` 并提示用 `cluster_exec` 配合 `tail`/`sed` 取片段。

### 7.3 `cluster_edit_file`

```python
async def cluster_edit_file(target: str, path: str, old_str: str, new_str: str, backup: bool = True, sudo: bool = False, sudo_password: str | None = None) -> dict
```

**description:**

```
精确替换集群节点上某文件中的一段内容(对标 Claude Code 的 Edit 工具)。

target 语法同 cluster_exec。
old_str 必须在文件中恰好出现一次,替换为 new_str。
出现 0 次或多次 → 报错(提示未找到/不唯一)。
backup=True(默认):替换前先备份原文件。
sudo=True:文件在需要 root 写权限的路径时使用。
sudo_password:同 cluster_exec(不传则用节点配置)。

适合修改配置文件中的某个字段——尤其当多个节点的文件内容各不相同时,
edit 可以广播("把所有节点的 port: 8080 改成 port: 8081"),
而 write_file 做不到(每台文件全文不同,无法统一覆盖)。
```

* **后端流程(全在 server 内部,文件全文不经过 agent)** :
* SFTP 读取文件内容到内存;
* 在内存中查找 `old_str`:出现 0 次 → `ok: false`,提示未找到;出现 >1 次 → `ok: false`,提示不唯一,需提供更多上下文;
* 恰好 1 次 → 执行替换;
* `backup=True` 且原文件存在 → 先备份为 `<path>.bak.<时间戳>`;
* SFTP 写回(sudo 场景走"暂存 + sudo mv");
* 成功字段:`changed: bool`、`backup_path: str | null`。

### 7.4 `cluster_write_file`

```python
async def cluster_write_file(target: str, path: str, content: str, backup: bool = True) -> dict
```

**description:**

```
向集群节点写入文件。

target 语法同 cluster_exec。
通过 SFTP 写入。backup=True(默认)时,若目标文件已存在,
先把原文件备份为 <path>.bak.<时间戳> 再写入。
广播写入多个节点时,可用于统一下发配置。
```

* **用 SFTP 写入** 。
* backup 逻辑:写入前检测目标是否存在,存在则复制为 `<path>.bak.<YYYYMMDD-HHMMSS>`。
* 成功字段:`bytes_written: int`、`backup_path: str | null`(无备份时为 null)。

### 7.5 `cluster_list_dir`

```python
async def cluster_list_dir(target: str, path: str) -> dict
```

**description:**

```
列出集群节点上某个目录的内容。

target 语法同 cluster_exec。
通过 SFTP 列目录,返回每个条目的名称、类型(file/dir)、大小。
```

* **用 SFTP 列目录** 。
* 成功字段:`entries: list`,每个元素 `{ "name": str, "type": "file" | "dir", "size": int }`。

### 7.6 `cluster_glob`

```python
async def cluster_glob(target: str, pattern: str, path: str = "/") -> dict
```

**description:**

```
在集群节点上按文件名模式递归查找文件(对标 Claude Code 的 Glob 工具)。

target 语法同 cluster_exec。
pattern:glob 模式,如 "*.yaml"、"*.conf"、"install*.sh"。
path:搜索起点目录,默认 "/"。
递归搜索 path 下所有匹配 pattern 的文件,返回路径、大小、修改时间。
结果上限 200 条,超限时提示缩小搜索范围。

常见用法:先 glob 找到文件 → 再 read_file 看内容 → 再 edit_file 改它。
```

* 后端通过 SSH 执行 `find <path> -name <pattern> -type f` 并解析结果;对每个匹配项取 `stat` 信息(或 `find` 配合 `-printf` 一次性输出路径、大小、mtime)。
* 成功字段:`matches: list`,每个元素 `{ "path": str, "size": int, "modified": str }`(`modified` 为 ISO 8601 格式)。
* 匹配数为 0 → `ok: true`,`matches: []`(空列表不算失败)。
* 超过 200 条 → 只返回前 200 条,附 `truncated: true`。

### 7.7 `cluster_system_info`

```python
async def cluster_system_info(target: str) -> dict
```

**description:**

```
获取集群节点的系统状态汇总:主机名、负载、内存、根分区磁盘、GPU。

target 语法同 cluster_exec。
GPU 信息通过 nvidia-smi 采集;无 GPU 或无 nvidia-smi 的节点 gpus 为空列表。
适合一眼掌握整个集群的资源占用,尤其是各节点 GPU 利用率和显存。
```

* 采集方式(每节点跑这几条命令并解析, **返回结构化数据而非原始文本** ):
  * 主机名:`hostname`
  * 负载:读 `/proc/loadavg` 取前三个数
  * 内存:`free -b` 或读 `/proc/meminfo`,取 total / used(字节)
  * 磁盘:`df -B1 /` 取根分区 total / used(字节)
  * GPU:`nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits`,逐行解析;命令不存在或失败 → `gpus: []`(不算节点失败)。
* 成功字段:

```json
{
  "ok": true,
  "hostname": "gpu-node-1",
  "load": [1.2, 1.0, 0.9],
  "memory": { "total_bytes": 540..., "used_bytes": 210... },
  "disk_root": { "total_bytes": ..., "used_bytes": ... },
  "gpus": [
    { "index": 0, "name": "NVIDIA H200", "mem_total_mb": 143771,
      "mem_used_mb": 32100, "util_pct": 87, "temp_c": 52 }
  ]
}
```

### 7.8 `cluster_service`

```python
async def cluster_service(target: str, service: str, action: str, sudo_password: str | None = None) -> dict
```

**description:**

```
管理集群节点上的 systemd 服务。

target 语法同 cluster_exec。
action 取值:status / start / stop / restart。
status 返回服务是否 active;start/stop/restart 执行对应操作。
start/stop/restart 自动以 sudo 执行(密码同 cluster_exec:sudo_password 参数 → 节点配置 → NOPASSWD);status 不加 sudo。
```

* `action` 限定为 `{status, start, stop, restart}`,非法值 → 报错。
* `status`:执行 `systemctl is-active <service>`(可附 `systemctl status --no-pager` 的简短输出)。
* `start/stop/restart`:执行 `systemctl <action> <service>`。
* 成功字段:`active: bool`(操作后服务是否 active)、`detail: str`(systemctl 简要输出)。
* start/stop/restart 自动套用 cluster_exec 的 sudo 机制(`sudo_password` 参数 or 节点配置 or NOPASSWD)。

### 7.9 `cluster_upload`

```python
async def cluster_upload(target: str, local_path: str, remote_path: str, mode: str | None = None, backup: bool = True, sudo: bool = False, sudo_password: str | None = None) -> dict
```

**description:**

```
把运行本 server 的机器(协调器 = 你的本地机器)上的文件或目录上传到集群节点。

target 语法同 cluster_exec。target="all" 时并行推送到所有节点,
适合向整个集群分发安装包、初始化脚本等。
local_path:本地路径;remote_path:节点上的目标路径。local_path 为目录时递归上传。
mode:可选权限(如 "755"),上传后对目标设置——部署可执行脚本常用。
backup=True(默认):目标已存在时先备份为 <remote_path>.bak.<时间戳> 再覆盖。
幂等:目标已存在且 sha256 与本地相同则跳过传输(部分失败后重跑安全、不重复传)。
sudo=True:目标在需要 root 的路径(如 /opt、/usr/local/bin、/etc)时使用。
sudo_password:同 cluster_exec(不传则用节点配置)。
```

* **经 SFTP 传输,文件字节不经过 agent 上下文** (与 `cluster_write_file` 区分:后者 content 来自 agent,适合小配置;upload 适合既有的/二进制的/较大文件)。
* 流程:先对本地文件算 sha256;若 `remote_path` 已存在且远端 sha256 相同 → 跳过,返回 `skipped: true`。否则:
  * SFTP 上传到节点临时路径(如 `/tmp/taproot-upload-<uuid>`),目录用 `recurse=True`;
  * `backup=True` 且目标已存在 → 先把目标 `mv`(或 `sudo -S mv`)到 `.bak.<时间戳>`;
  * 把临时文件移动到 `remote_path`——`sudo=False` 用 `mv`,`sudo=True` 用 `sudo -S mv`( **SFTP 自身无法 sudo,故必须"暂存 + sudo 移动"** );
  * `mode` 给定则 `chmod`(需要时配合 sudo);
  * 失败时清理临时文件。
* 成功字段:`remote_path: str`、`bytes: int`(目录则附 `files: int`)、`sha256: str`、`mode: str | null`、`backup_path: str | null`、`skipped: bool`。

### 7.10 `cluster_download`

```python
async def cluster_download(target: str, remote_path: str, local_path: str) -> dict
```

**description:**

```
把集群节点上的文件下载到运行本 server 的机器(协调器 = 你的本地机器)。

target 语法同 cluster_exec。
remote_path:节点上的路径;local_path:本地保存路径。
target 匹配多个节点时,各节点文件分别存到 local_path 下以节点名命名的子目录
(如 local_path/gpu-node-1/...),避免互相覆盖。
若 remote_path 仅 root 可读,先用 cluster_exec 配合 sudo 复制到可读位置再下载。
```

* **经 SFTP 传输** 。
* 多节点:保存到 `local_path/<node>/<basename>`,防覆盖;单节点:直接存到 `local_path`。
* 成功字段:`local_path: str`、`bytes: int`、`sha256: str`。

---

## 8. SSH 层实现要求(ssh_pool.py)

* **连接池** :维护 `dict[node_name -> asyncssh connection]`。首次用到某节点时惰性建连,之后复用。开启 keepalive。连接断开时,下次使用自动重连一次(重连仍失败则该节点报 `ok: false`)。
* **文件操作(read/write/edit/list)走 SFTP;命令操作(exec/service/system_info)走 `conn.run()`。** 这是有意的分工——文件操作用 SFTP 避免 shell 转义地狱。`cluster_edit_file` 的流程是 SFTP 读 → 内存替换 → SFTP 写回(sudo 场景加"暂存 + sudo mv"),文件全文不经过 agent。
* **文件搜索(glob)走 SSH exec** :`cluster_glob` 通过 `find` 命令实现,结果解析为结构化列表返回。
* **文件传输(upload/download)走 SFTP** :上传采用"暂存 /tmp + `mv`/`sudo -S mv`"(SFTP 无法 sudo);上传前用远端 sha256 比对做幂等跳过;`target="all"` 并行推送;多节点下载存到 `local_path/<node>/` 防覆盖。
* **sudo 注入** :`sudo=True`(或 service 的 start/stop/restart)执行 `sudo -S -p '' <cmd>`,把密码经 stdin 喂入(`conn.run(..., input=pw)`);密码优先级 `sudo_password 参数 → 节点配置 → NOPASSWD`。密码可来自 nodes.yaml(主)或调用参数(临时入口)。
* **广播并行** :target 解析出节点列表后,用 `asyncio.gather(*[op(node) for node in nodes], return_exceptions=True)` 并行执行。把抛出的异常转换成 `{ "ok": false, "error": str(exc) }`, **绝不让单个节点的失败导致整个工具调用抛异常** 。
* **每节点超时** :连接和命令都要有超时,超时归为该节点失败。
* 并行化在 server 内部完成, **不依赖 agent 客户端支持并行 tool call** ——这正是 fleet 设计相对 node-level 的关键优势。

---

## 9. 传输层( **main** .py)

taproot-mcp 作为本地进程运行。当前产品路径里， **Codex 主路径是连接 VS Code 插件启动的 Streamable HTTP server** ；stdio 仍保留给 Claude Code、调试和其他按命令拉起 server 的客户端。

支持两种 transport,通过命令行参数选择:

* **Streamable HTTP** (`--transport http --host 127.0.0.1 --port 8765`):Codex 主路径。由 VS Code 扩展启动并管理,或手动启动用于调试。Codex 连接这个 URL,不再单独拉起一个 taproot-mcp 子进程。
* **stdio** :保留给 Claude Code、本地调试和其他按命令拉起 server 的客户端。仍然是本地子进程直连,无需监听端口。

另外提供一个  **`check` 子命令** :`taproot-mcp check` —— 加载配置、尝试连接所有节点、打印每个节点的连通状态(成功/失败原因),用于在接入 agent 之前验证配置。这个命令对调试很重要,请务必实现。

主命令(`taproot-mcp` 或 `taproot-mcp serve`)启动 MCP server。

---

## 10. 错误处理原则

* 单节点失败 → 记录在该节点的 `results` 条目里(`ok: false` + `error`),并计入 `summary.failed`。**整个工具调用照常返回成功的信封,不抛异常。**
* 配置错误(文件缺失、字段非法)→ 启动时即报错退出,信息要具体。
* 错误处理保持简单:重连最多一次, **不实现退避重试循环** 。报告失败即可,把"要不要重试"的决策留给 agent。

---

## 11. v0.1 范围边界(重要——以下功能一律不实现)

为保证第一版能快速跑起来,**明确不做**下列东西。如果你认为某项"顺手就能加",也请克制:

* ❌ 不集成 SaltStack / Ansible / 任何需要在节点上装 agent 的方案——纯 SSH。
* ❌ 不集成 Prometheus / Loki / 任何指标或日志存储后端(监控是独立领域,日后若需要应是独立 MCP server)。
* ❌ 不做命令白名单 / 审批门控(command whitelist / approval gate)。
* ❌ 不做审计日志(audit log)。
* ❌ 不做自动任务路由 / 负载均衡 / 按节点能力调度。
* ❌ 不做 Web UI / dashboard。
* ❌ 不做凭证保险库(credential vault)——SSH key/password 与 sudo_password 均来自 nodes.yaml(明文)或调用参数;无加密存储。
* ❌ 不做退避重试循环、不做断路器。
* ❌ 不做专门的 grep / 文件内容搜索工具——`cluster_exec` 配合 `grep -rn` 足够;agent 对 grep 旗标非常熟练,返回格式高度标准化,专门工具的边际收益不值得多一个工具定义。
* ❌ v0.1 不实现任何有状态会话工具(它们属于 v0.2,见第 14 节);v0.1 的 `cluster_exec` 必须无状态。
* ❌ 永远不要自建常驻 daemon、不走 master-minion 重型分布式方案;v0.2 的持久会话只用 tmux 实现。

v0.1 = 10 个工具(镜像 Claude Code 本地体验的 exec/read/edit/write/list_dir/glob + 集群特有的 system_info/service/upload/download)+ 配置加载 + target 解析 + SSH 连接池 + 双 transport + check 子命令。仅此而已。**请先完整交付 v0.1 再做 v0.2;实现 v0.1 时不要在架构上堵死 v0.2(例如 ssh_pool 的连接复用应能被 sessions 模块共用)。**

> **影响范围提醒** :加入 sudo + 文件分发后,`target="all"` 配合 `sudo=True` 意味着一次调用就能以 root 改动整个集群——agent 的一次误判,或它从某个节点读到的被污染内容诱导出的指令,都可能放大到全部机器。在隔绝内网里这是可接受的主动选择;但建议把当前排除的 **审计日志** (谁、在哪些节点、执行了什么 sudo/上传操作)作为 v0.1 跑通后第一个补上的东西,而不是无限期排除。

---

## 12. 代码质量要求

* 全程使用类型注解(type hints)。
* 每个工具、每个公开函数有 docstring。工具的 docstring 即面向 LLM 的 description,按第 7 节的文本来写, **务必把 target 语法用例子列出** 。
* 模块职责清晰(见第 3 节结构),`targeting.py` 与 `config.py` 的逻辑应可独立单元测试。
* 给 `targeting.py`(target 解析)和 `config.py`(defaults 合并)写少量单元测试。

---

## 13. 交付物与验收

**交付物:**

* 可安装运行的包:`pip install -e .` 后存在 `taproot-mcp` 命令入口。
* `nodes.yaml.example` 模板。
* `README.md`,包含:安装步骤、配置说明、`check` 子命令用法、以及如何让 **Codex** 连接 VS Code 插件启动的 HTTP server、以及让 **Claude Code** 注册本 server 的示例。

**验收场景(请据此自查):**

1. `cluster_system_info(target="all")` 返回每个节点一个条目,GPU 节点带 `gpus` 数据。
2. `cluster_exec(target="tag:vllm", command="nvidia-smi -L")` 只在带 `vllm` 标签的节点执行。
3. `cluster_exec(target="gpu-*", command="uptime")` 通配符正确匹配。
4. 某节点宕机时,它在 `results` 中显示 `ok: false` 且 `summary.failed` +1, **调用不抛异常** ,其他节点结果正常返回。
5. `cluster_write_file(..., backup=true)` 在目标已存在时先生成带时间戳的备份再写入,且通过 SFTP 完成。
6. `cluster_read_file` 通过 SFTP 读取,超大文件给出友好提示。
7. `cluster_edit_file(target="all", path="/etc/myapp/config.yaml", old_str="port: 8080", new_str="port: 8081")` 在每个节点的文件中精确替换一次;各节点文件其余内容不同也不影响。`old_str` 未找到或找到多次 → `ok: false` 报错。
8. `cluster_glob(target="gpu-node-1", pattern="*.yaml", path="/etc/myapp")` 返回结构化的匹配文件列表(path/size/modified)。
9. `cluster_upload(target="all", local_path="./install.sh", remote_path="/tmp/install.sh", mode="755")` 并行分发并置可执行;随后 `cluster_exec(target="all", command="/tmp/install.sh", sudo=True)` 以 root 执行。重复运行同一 upload → 各节点 `skipped: true`(幂等)。
10. `cluster_upload(..., remote_path="/usr/local/bin/myapp", sudo=true)` 经"暂存 + sudo mv"落到 root 目录;目标已存在则先生成 `.bak.<时间戳>`。
11. `cluster_download(target="all", remote_path="/var/log/app.log", local_path="./logs")` 把各节点日志分别存到 `./logs/<node>/app.log`,互不覆盖。

---

## 14. v0.2 路线:有状态会话(tmux)

> v0.2 目标:为"多步依赖 cwd/env 的流程"和"活 shell / 流式输出"提供持久会话。**先交付 v0.1,本节为 v0.2;但 v0.1 的架构不应堵死它。**

### 14.1 原理

不自建常驻 daemon,用  **tmux 充当远端的常驻进程** ——它就是 VS Code Remote-SSH 里那个"远端常驻 server"的轻量替身:每台机器上一个命名 tmux session 持有一个真实 PTY,所以 `cd`、`export`、`source venv`、活着的 REPL/前台进程都能跨调用持久。MCP server(协调器)通过 SSH 用 `tmux` 子命令跟这些 session 对话:`send-keys` 喂命令,`capture-pane` 读输出。

会话 **天然单节点、不广播** (会话 = 一台机器上的一份状态)。需要广播的批量操作走 v0.1 的无状态工具。

 **一个有用的鲁棒性副产品** :tmux session 独立于 MCP server 存活——即使 MCP server 重启,远端会话仍在。会话用统一前缀 `taproot-` 命名,便于发现与恢复。

### 14.2 会话注册表

协调器在内存维护 `session_id -> (node_name, tmux_session_name)` 映射。`session_id` 用短 uuid;tmux session 名为 `taproot-<session_id>`。`cluster_session_list` 应以节点上实际存在的 `taproot-*` tmux session 为准(查询真实状态),内存表为辅。

### 14.3 命令完成检测(关键,必须做对)

tmux 的输出捕获没有干净的 exit-code 边界, **必须用 sentinel marker** :

执行一条命令时,实际 send-keys 的内容是:

```
<command>; printf "\nTAPROOT_DONE_<marker> %d\n" $?
```

其中 `<marker>` 是本次调用的唯一 token。随后轮询 `tmux capture-pane -p -t <session>`,直到出现含该 marker 的行:

* 命令输出 = 命令回显之后、marker 行之前的内容;
* exit_code = 从 marker 行解析出的整数。

设一个总轮询超时;超时则返回 `ok: false`(命令可能仍在运行,提示用 `cluster_session_read` 查看)。**不要假设命令瞬间完成。**

### 14.4 工具选择指南(面向 agent 的路由规则)

> 以下内容是面向使用本 server 的 agent 的决策指南。实现者应把这段规则浓缩后写入 `cluster_session_open` 的 description,让 agent 在决定是否打开会话前先看到它。

**默认用无状态工具(cluster_exec / read / edit / write / glob 等)。** 它们返回干净的结构化 JSON,支持多节点广播,可安全重试,且不消耗远端资源。日常 90% 的操作——查看系统状态、执行单条命令、读写配置、部署文件——都应该用无状态工具完成。

**仅在以下场景打开 tmux 会话：**

1. **多步流程依赖持久状态** ——需要先 `cd` 到某个目录、`source` 一个 venv、`export` 环境变量,然后在此基础上连续执行多条命令。如果只是单条命令需要工作目录,用 `cluster_exec(cwd=...)` 即可,不需要会话。
2. **交互式进程** ——需要启动一个 REPL(python / node / mysql)、或一个需要交互输入的安装程序(如 `apt install` 的交互确认),且无法用 `-y` 等非交互旗标绕过。
3. **观察流式输出** ——需要跟踪一个长时运行的前台进程(如 `tail -f`、训练脚本、`vllm serve` 启动日志),用 `cluster_session_read` 轮询查看最新输出。

**不应该打开会话的场景（用无状态工具更好）：**

* 执行单条命令,即使是复杂的管道命令 → `cluster_exec`
* 查看 / 修改文件 → `cluster_read_file` / `cluster_edit_file` / `cluster_write_file`
* 查找文件 → `cluster_glob`
* 查看系统状态 → `cluster_system_info`
* 管理服务 → `cluster_service`
* 上传 / 下载文件 → `cluster_upload` / `cluster_download`
* 需要对多个节点做同一件事 → 无状态工具的 `target` 参数(会话不支持广播)

### 14.5 工具定义

返回信封沿用第 6 节结构(`ok` + 字段;失败带 `error`)。会话工具是单节点的,`results` 中只有一个条目。注意:这组工具用参数名 `node`(单节点)而非 `target`,以此向 agent 表明"会话不广播"。

#### `cluster_session_open`

```python
async def cluster_session_open(node: str) -> dict
```

**description:**

```
在指定节点上打开一个持久 shell 会话(底层为 tmux),返回 session_id。
后续用 cluster_session_exec 在同一会话里执行命令——cd / export / source 等状态会保留。
node 必须是单个节点名(会话不支持广播)。用完请用 cluster_session_close 关闭。

⚠️ 打开会话前请确认是否真的需要:
- 单条命令(哪怕很复杂) → 用 cluster_exec(可带 cwd)
- 读/改/写文件 → 用 cluster_read_file / cluster_edit_file / cluster_write_file
- 上传下载 → 用 cluster_upload / cluster_download
- 查系统状态 → 用 cluster_system_info
- 管理服务 → 用 cluster_service
以上场景用无状态工具更快、结果更干净、支持多节点。
仅当需要跨多条命令保持 cd/env 状态、交互式进程、或观察流式输出时,才打开会话。
```

* 行为:`tmux new-session -d -s taproot-<id>`;登记 session_id。tmux 不存在则返回清晰报错。
* 成功字段:`session_id: str`、`node: str`。

#### `cluster_session_exec`

```python
async def cluster_session_exec(session_id: str, command: str, timeout: int = 60) -> dict
```

**description:**

```
在已打开的会话中执行命令,保留该会话的 shell 状态(工作目录、环境变量等)。
返回命令输出与 exit_code。用于多步、依赖上下文的流程。
```

* 行为:见 14.3 的 sentinel 机制。
* 成功字段:`output: str`、`exit_code: int`。
* session_id 不存在 → `ok: false`。

#### `cluster_session_read`

```python
async def cluster_session_read(session_id: str, lines: int = 100) -> dict
```

**description:**

```
读取会话当前的屏幕缓冲(capture-pane),用于查看流式/长时运行命令的最新输出
(如 tail -f、训练日志、正在运行的进程)。返回最近 lines 行。
```

* 行为:`tmux capture-pane -p -t <session>`,取尾部 `lines` 行。
* 成功字段:`output: str`。
* 这是**轮询式**查看;v0.2 不实现 MCP 流式返回(真流式留待后续)。

#### `cluster_session_interrupt`

```python
async def cluster_session_interrupt(session_id: str) -> dict
```

**description:**

```
向会话发送 Ctrl-C,用于中断正在运行的前台命令(如停止 tail -f)。
```

* 行为:`tmux send-keys -t <session> C-c`。
* 成功字段:`ok: true`。

#### `cluster_session_close`

```python
async def cluster_session_close(session_id: str) -> dict
```

**description:**

```
关闭会话并释放远端资源。
```

* 行为:`tmux kill-session -t <session>`;从注册表移除。
* 成功字段:`closed: bool`。

#### `cluster_session_list`

```python
async def cluster_session_list() -> dict
```

**description:**

```
列出当前所有打开的会话及其所在节点。
```

* 行为:在已知节点上 `tmux ls` 过滤 `taproot-*`(辅以内存注册表)。
* 成功字段:`sessions: list`,元素 `{ "session_id": str, "node": str }`。

### 14.6 v0.2 前提与边界

* 目标节点需安装 tmux;缺失时 `cluster_session_open` 返回清晰报错。
* 会话工具 **复用 v0.1 的 `ssh_pool` 连接池** ——这就是"v0.1 不应堵死 v0.2"的具体含义。
* sentinel marker 解析、轮询超时要稳妥;捕获的输出里可能混入命令回显与提示符,解析时注意剥离。
* 仍然不做:自建 daemon、master-minion、真流式推送、会话持久化到磁盘。

---

## 备注:tool description 的语言

上述 docstring 用中文撰写。这些 description 是面向使用本 server 的 agent 的 prompt;若日后开源面向英文社区,把各段 description 翻译为英文即可,字段名与代码保持英文不变。
