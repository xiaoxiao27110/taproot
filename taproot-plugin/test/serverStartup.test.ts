import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import test from 'node:test';

import { waitForHttpServerReady } from '../src/serverStartup';

test('waitForHttpServerReady waits until the MCP endpoint responds', async () => {
  const child = { exitCode: null } as cp.ChildProcess;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error('ECONNREFUSED');
    }
    return new Response('', { status: 405 });
  }) as typeof fetch;

  await waitForHttpServerReady('http://127.0.0.1:8765/mcp', child, 2_000, fetchImpl);

  assert.equal(calls, 3);
});

test('waitForHttpServerReady fails when the process exits before readiness', async () => {
  const child = { exitCode: null } as cp.ChildProcess;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    (child as { exitCode: number | null }).exitCode = 2;
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  await assert.rejects(
    waitForHttpServerReady('http://127.0.0.1:8765/mcp', child, 2_000, fetchImpl),
    /process exited before readiness with code 2/,
  );
  assert.equal(calls, 1);
});
