import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as net from 'node:net';
import test from 'node:test';

import { isTcpPortOpen, waitForHttpServerReady } from '../src/serverStartup';

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

test('isTcpPortOpen detects a listening port', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  assert.equal(await isTcpPortOpen('127.0.0.1', address.port), true);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  assert.equal(await isTcpPortOpen('127.0.0.1', address.port, 100), false);
});
