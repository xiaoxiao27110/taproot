import * as cp from 'node:child_process';
import * as net from 'node:net';

import { summarizeProcessError } from './processError';

export function isTcpPortOpen(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function waitForHttpServerReady(
  url: string,
  child: cp.ChildProcess,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited before readiness with code ${child.exitCode}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      await fetchImpl(url, { method: 'GET', signal: controller.signal });
      await delay(250);
      if (child.exitCode !== null) {
        throw new Error(`process exited before readiness with code ${child.exitCode}`);
      }
      return;
    } catch (error) {
      lastError = summarizeProcessError(error);
    } finally {
      clearTimeout(timer);
    }

    await delay(250);
  }

  throw new Error(`timed out waiting for ${url}${lastError ? ` (${lastError})` : ''}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
