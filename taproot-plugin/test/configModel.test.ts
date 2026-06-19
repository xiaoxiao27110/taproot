import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DashboardState,
  makeSshCommand,
  parseNodesYaml,
  serializeNodesYaml,
  validateState,
} from '../src/configModel';

const backend = { connected: true, message: 'ok' };

test('parseNodesYaml maps PRD config into UI state and preserves extra fields', () => {
  const state = parseNodesYaml(
    `
defaults:
  user: admin
  key: ~/.ssh/id_rsa
  port: 22
  sudo_password: secret
nodes:
  gpu-node-1:
    host: 192.168.1.101
    tags: [gpu, vllm]
  dev-vm:
    host: 192.168.1.200
    user: deploy
    key: ~/.ssh/dev
    port: 2222
    password: pw
    tags: [dev]
`,
    '/tmp/nodes.yaml',
    backend,
  );

  assert.equal(state.defaults.user, 'admin');
  assert.equal(state.defaults.port, '22');
  assert.equal(state.defaults.sudo, 'secret');
  assert.equal(state.defaults.extra.key, '~/.ssh/id_rsa');
  assert.equal(state.nodes.length, 2);
  assert.equal(state.nodes[1].user, 'deploy');
  assert.equal(state.nodes[1].pwd, 'pw');
  assert.equal(state.nodes[1].extra.key, '~/.ssh/dev');
});

test('serializeNodesYaml omits inherited empty overrides but keeps key extras', () => {
  const state = parseNodesYaml(
    `
defaults:
  user: admin
  key: ~/.ssh/id_rsa
  port: 22
nodes:
  gpu-node-1:
    host: localhost
    tags: [local]
`,
    '/tmp/nodes.yaml',
    backend,
  );
  state.nodes[0].user = '';
  state.nodes[0].port = '';
  state.nodes[0].tags.push('vllm');

  const yaml = serializeNodesYaml(state);

  assert.match(yaml, /key: ~\/\.ssh\/id_rsa/);
  assert.match(yaml, /gpu-node-1:/);
  assert.match(yaml, /host: localhost/);
  assert.match(yaml, /- vllm/);
  assert.doesNotMatch(yaml, /gpu-node-1:\n(?:.*\n)*?\s+user:/);
});

test('validateState catches duplicate names and missing host', () => {
  const state: DashboardState = {
    configPath: '/tmp/nodes.yaml',
    backend,
    defaults: { user: 'admin', port: '22', pwd: '', sudo: '', extra: {} },
    nodes: [
      { id: 1, name: 'node-a', host: '', user: '', port: '', pwd: '', sudo: '', tags: [], status: 'inactive', extra: {} },
      { id: 2, name: 'node-a', host: 'localhost', user: '', port: 'bad', pwd: '', sudo: '', tags: [], status: 'inactive', extra: {} },
    ],
  };

  const result = validateState(state);

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('host 必填')));
  assert(result.errors.some((error) => error.includes('名称重复')));
  assert(result.errors.some((error) => error.includes('port')));
});

test('makeSshCommand uses effective defaults and quotes shell-sensitive values', () => {
  const state = parseNodesYaml(
    `
defaults:
  user: admin user
  port: 22
nodes:
  local:
    host: localhost
`,
    '/tmp/nodes.yaml',
    backend,
  );

  assert.equal(makeSshCommand(state.defaults, state.nodes[0]), "ssh -p 22 'admin user@localhost'");
});
