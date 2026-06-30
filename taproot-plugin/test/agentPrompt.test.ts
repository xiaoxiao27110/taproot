import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentPrompt } from '../src/agentPrompt';

test('buildAgentPrompt describes the shared HTTP Taproot backend', () => {
  const prompt = buildAgentPrompt({
    configPath: '/tmp/nodes.yaml',
    releaseUrl: 'https://github.com/xiaoxiao27110/taproot/releases/latest',
    serverUrl: 'http://127.0.0.1:8765/mcp',
    taprootCommand: 'taproot-mcp',
  });

  assert.match(prompt, /streamable-http/);
  assert.match(prompt, /http:\/\/127\.0\.0\.1:8765\/mcp/);
  assert.match(prompt, /安装\/更新、首次启动和 MCP 连接/);
  assert.match(prompt, /https:\/\/github\.com\/xiaoxiao27110\/taproot\/releases\/latest/);
  assert.match(prompt, /taproot_mcp-\*-/);
  assert.doesNotMatch(prompt, /\/tmp\/taproot\.whl/);
  assert.match(prompt, /不要使用本机硬编码路径/);
  assert.match(prompt, /taproot-mcp serve --config \/tmp\/nodes\.yaml --transport http --host 127\.0\.0\.1 --port 8765/);
  assert.match(prompt, /cluster_nodes/);
  assert.match(prompt, /nodes\.yaml: \/tmp\/nodes\.yaml/);
});

test('buildAgentPrompt adds a remote workspace hint when remoteName is set', () => {
  const prompt = buildAgentPrompt({
    configPath: '/workspace/nodes.yaml',
    releaseUrl: 'https://github.com/xiaoxiao27110/taproot/releases/latest',
    remoteName: 'ssh-remote',
    serverUrl: 'http://127.0.0.1:8765/mcp',
    taprootCommand: 'taproot-mcp',
  });

  assert.match(prompt, /远程工作区场景/);
  assert.match(prompt, /ssh-remote/);
});
