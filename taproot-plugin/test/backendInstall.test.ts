import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  probePython,
  resolvePythonCommand,
  RunProcess,
  satisfiesRequiresPython,
  taprootInstallArgs,
} from '../src/backendInstall';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..', '..');

test('bundled wheel metadata resolves Requires-Python', async () => {
  const wheel = await bundledWheelPath();
  const probe = await probePython({ command: process.env.PYTHON || 'python3', args: [] }, wheel, execRunProcess);

  assert.equal(probe.requiresPython, '>=3.10');
});

test('Python requirement check rejects Python 3.9 for the bundled backend', () => {
  assert.equal(satisfiesRequiresPython('3.9.9', '>=3.10'), false);
  assert.equal(satisfiesRequiresPython('3.10.0', '>=3.10'), true);
});

test('Python resolver selects versioned Python 3.10 before python3 fallback', async () => {
  const runProcess = fakePythonRunProcess({
    'python3.13': undefined,
    'python3.12': undefined,
    'python3.11': undefined,
    'python3.10': '3.10.12',
    python3: '3.9.9',
  });

  const python = await resolvePythonCommand('', '/tmp/taproot.whl', runProcess);

  assert.equal(python.command, 'python3.10');
  assert.equal(python.version, '3.10.12');
});

test('configured Python 3.9 produces a concise version error', async () => {
  const runProcess = fakePythonRunProcess({ python3: '3.9.9' });

  await assert.rejects(
    resolvePythonCommand('python3', '/tmp/taproot.whl', runProcess),
    /Selected Python is 3\.9, but taproot-mcp requires >=3\.10/,
  );
});

test('pip startup failure is summarized before installation', async () => {
  const runProcess = fakePythonRunProcess(
    { python3: '3.10.12' },
    new Error(
      [
        'Traceback (most recent call last):',
        '  File "pip", line 1, in <module>',
        "PermissionError: [Errno 13] Permission denied: '/usr/local/lib64/python3.9/site-packages/websockets-12.0.dist-info'",
      ].join('\n'),
    ),
  );

  await assert.rejects(
    resolvePythonCommand('python3', '/tmp/taproot.whl', runProcess, { requirePip: true }),
    /pip failed before installation; please fix pip or configure taproot\.pythonCommand\. PermissionError/,
  );
});

test('taprootInstallArgs only uses --user after explicit approval', () => {
  assert.deepEqual(taprootInstallArgs('/tmp/taproot.whl', false), [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '/tmp/taproot.whl',
  ]);
  assert.deepEqual(taprootInstallArgs('/tmp/taproot.whl', true), [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--user',
    '/tmp/taproot.whl',
  ]);
});

async function bundledWheelPath(): Promise<string> {
  const backendDir = path.join(root, 'backend');
  const wheel = (await readdir(backendDir)).find((name) => /^taproot_mcp-.*\.whl$/.test(name));
  assert(wheel, 'bundled backend wheel is missing');
  return path.join(backendDir, wheel);
}

async function execRunProcess(command: string, args: string[], timeoutMs: number) {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: timeoutMs });
  return { stdout, stderr };
}

function fakePythonRunProcess(versions: Record<string, string | undefined>, pipError?: Error): RunProcess {
  return async (command: string, args: string[]) => {
    const version = versions[command];
    if (!version) {
      throw new Error(`${command}: command not found`);
    }
    if (args.includes('-m') && args.includes('pip') && args.includes('--version')) {
      if (pipError) {
        throw pipError;
      }
      return { stdout: `pip 24 from /tmp (${command})\n`, stderr: '' };
    }
    if (args.includes('-c')) {
      return {
        stdout: `${JSON.stringify({
          executable: `/usr/bin/${command}`,
          version: version.split('.').map((part) => Number(part)),
          requires_python: '>=3.10',
        })}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}
