import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseNodesYaml, serializeNodesYaml } from '../src/configModel';

const execFileAsync = promisify(execFile);

test('serialized dashboard config works with taproot-mcp check', { skip: !process.env.TAPROOT_TEST_CONFIG }, async () => {
  const source = process.env.TAPROOT_TEST_CONFIG;
  assert(source);
  const text = await readFile(source, 'utf8');
  const state = parseNodesYaml(text, source, { connected: true, message: 'ok' });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'taproot-plugin-check-'));
  const tmpConfig = path.join(tmpDir, 'nodes.yaml');
  try {
    await writeFile(tmpConfig, serializeNodesYaml(state), 'utf8');
    const { stdout } = await execFileAsync('taproot-mcp', ['check', '--config', tmpConfig], {
      timeout: 45_000,
    });

    for (const node of state.nodes) {
      assert.match(stdout, new RegExp(`${node.name}: ok`));
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
