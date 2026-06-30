export interface AgentPromptOptions {
  configPath: string;
  releaseUrl: string;
  remoteName?: string;
  serverUrl: string;
  taprootCommand: string;
}

export function buildAgentPrompt(options: AgentPromptOptions): string {
  const server = parseServerUrl(options.serverUrl);
  const lines = [
    '请在当前 Agent 所在机器上完成 Taproot MCP backend 的安装/更新、首次启动和 MCP 连接。',
    '',
    '已知信息：',
    `- nodes.yaml: ${options.configPath}`,
    `- Taproot 后端 release: ${options.releaseUrl}`,
    `- 期望 MCP URL: ${options.serverUrl}`,
    `- 当前 taproot-mcp 命令: ${options.taprootCommand}`,
    '',
    '执行要求：',
    '1. 先检查当前环境、Python 版本和已有 taproot-mcp，不要盲目整段运行固定脚本。',
    '2. 如需安装/更新，到上面的 GitHub release 下载最新的 taproot_mcp-*-py3-none-any.whl，不要使用本机硬编码路径。',
    '3. 建议使用隔离的 Python 3.10+ venv；安装后确认 taproot-mcp --help 可运行。',
    `4. 用 nodes.yaml 启动 HTTP MCP server: ${options.taprootCommand} serve --config ${shellQuote(options.configPath)} --transport http --host ${shellQuote(server.host)} --port ${server.port}`,
    '5. 确认 HTTP server 可访问后，把当前 Agent 的 MCP 配置连接到下面这个 Streamable HTTP server。',
    '6. 连接成功后先调用 cluster_nodes，确认节点列表；后续所有 Taproot 操作都走这个连接。',
    '',
    'MCP server 配置：',
    '```json',
    JSON.stringify(
      {
        name: 'taproot',
        transport: 'streamable-http',
        url: options.serverUrl,
      },
      null,
      2,
    ),
    '```',
  ];

  if (options.remoteName) {
    lines.push(
      '',
      `当前是 VS Code 远程工作区场景 (${options.remoteName})；安装、启动和 MCP 连接都必须发生在运行 Taproot 插件的同一台远程机器上。`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function parseServerUrl(serverUrl: string): { host: string; port: string } {
  try {
    const parsed = new URL(serverUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    };
  } catch {
    return { host: '127.0.0.1', port: '8765' };
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
