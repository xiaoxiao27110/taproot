import * as os from 'node:os';
import * as path from 'node:path';

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
}

export type RunProcess = (command: string, args: string[], timeoutMs: number) => Promise<ProcessOutput>;

export interface PythonProbe extends CommandSpec {
  executable: string;
  version: string;
  requiresPython: string;
}

const PYTHON_PROBE_SCRIPT = `
import email
import json
import os
import sys
import zipfile

payload = {
    "executable": sys.executable,
    "version": [sys.version_info.major, sys.version_info.minor, sys.version_info.micro],
    "requires_python": "",
}
source = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    if source and os.path.isfile(source) and zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as wheel:
            metadata_name = next((name for name in wheel.namelist() if name.endswith(".dist-info/METADATA")), None)
            if metadata_name:
                metadata = wheel.read(metadata_name).decode("utf-8", "replace")
                message = email.message_from_string(metadata)
                payload["requires_python"] = message.get("Requires-Python", "") or ""
except Exception as exc:
    payload["metadata_error"] = str(exc)
print(json.dumps(payload))
`;

export function pythonCandidates(configuredCommand: string): CommandSpec[] {
  const configured = configuredCommand.trim();
  if (configured) {
    return [{ command: expandHome(configured), args: [] }];
  }

  const candidates: CommandSpec[] = [];
  const minors = [13, 12, 11, 10];
  if (process.platform === 'win32') {
    for (const minor of minors) {
      candidates.push({ command: 'py', args: [`-3.${minor}`] });
    }
    candidates.push({ command: 'py', args: ['-3'] });
    candidates.push({ command: 'python', args: [] });
    candidates.push({ command: 'python3', args: [] });
  } else {
    for (const minor of minors) {
      candidates.push({ command: `python3.${minor}`, args: [] });
    }
    candidates.push({ command: 'python3', args: [] });
    candidates.push({ command: 'python', args: [] });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.args.join('\0')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function probePython(
  candidate: CommandSpec,
  installSource: string,
  runProcess: RunProcess,
): Promise<PythonProbe> {
  const output = await runProcess(candidate.command, [...candidate.args, '-c', PYTHON_PROBE_SCRIPT, installSource], 10_000);
  const line = output.stdout.trim().split(/\r?\n/).pop() || '{}';
  const parsed = JSON.parse(line) as {
    executable?: string;
    version?: number[];
    requires_python?: string;
    metadata_error?: string;
  };
  if (parsed.metadata_error) {
    throw new Error(`failed to read bundled wheel metadata: ${parsed.metadata_error}`);
  }
  const version = parsed.version;
  if (!Array.isArray(version) || version.length < 2) {
    throw new Error('Python probe did not return a version.');
  }
  return {
    ...candidate,
    executable: parsed.executable || candidate.command,
    version: version.join('.'),
    requiresPython: parsed.requires_python || '',
  };
}

export async function resolvePythonCommand(
  configuredCommand: string,
  installSource: string,
  runProcess: RunProcess,
  options: { requirePip?: boolean } = {},
): Promise<PythonProbe> {
  const candidates = pythonCandidates(configuredCommand);
  const failures: string[] = [];
  for (const candidate of candidates) {
    let probe: PythonProbe;
    try {
      probe = await probePython(candidate, installSource, runProcess);
    } catch (error) {
      failures.push(`${describeCommand(candidate)}: ${summarizeProcessError(error)}`);
      continue;
    }

    if (!satisfiesRequiresPython(probe.version, probe.requiresPython)) {
      const requirement = probe.requiresPython || 'the bundled backend requirement';
      failures.push(`Selected Python is ${majorMinor(probe.version)}, but taproot-mcp requires ${requirement}.`);
      continue;
    }

    if (options.requirePip) {
      try {
        await checkPythonPip(probe, runProcess);
      } catch (error) {
        failures.push(`${describeCommand(candidate)}: ${formatPipFailure(error)}`);
        continue;
      }
    }

    return probe;
  }

  if (configuredCommand.trim()) {
    throw new Error(failures[0] || 'Configured Python is not usable. Set taproot.pythonCommand to Python 3.10+.');
  }

  const requirement = requirementFromFailures(failures);
  throw new Error(
    `No compatible Python found${requirement ? ` for ${requirement}` : ''}. ` +
      'Install Python 3.10+ or set taproot.pythonCommand.',
  );
}

export async function checkPythonPip(python: CommandSpec, runProcess: RunProcess): Promise<void> {
  await runProcess(python.command, [...python.args, '-m', 'pip', '--version'], 10_000);
}

export async function pythonUsesVirtualEnv(python: CommandSpec, runProcess: RunProcess): Promise<boolean> {
  const code = 'import sys; print(int(getattr(sys, "base_prefix", sys.prefix) != sys.prefix))';
  try {
    const output = await runProcess(python.command, [...python.args, '-c', code], 10_000);
    return output.stdout.trim().split(/\r?\n/).pop() === '1';
  } catch {
    return false;
  }
}

export function taprootInstallArgs(installSource: string, useUserInstall: boolean): string[] {
  const args = ['-m', 'pip', 'install', '--upgrade'];
  if (useUserInstall) {
    args.push('--user');
  }
  args.push(installSource);
  return args;
}

export function managedVenvDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'taproot-mcp', 'venv');
  }
  return path.join(os.homedir(), '.local', 'share', 'taproot-mcp', 'venv');
}

export function managedVenvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

export function managedVenvTaprootCommand(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'taproot-mcp.exe')
    : path.join(venvDir, 'bin', 'taproot-mcp');
}

export function satisfiesRequiresPython(version: string, spec: string): boolean {
  const trimmed = spec.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.split(',').every((part) => satisfiesSpecifier(version, part.trim()));
}

export function summarizeProcessError(error: unknown, maxLength = 400): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const actionable = [...lines]
    .reverse()
    .find((line) => !line.startsWith('File "') && !line.startsWith('Traceback '));
  const summary = actionable || lines[0] || message;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}...` : summary;
}

export function formatPipFailure(error: unknown): string {
  return `pip failed before installation; please fix pip or configure taproot.pythonCommand. ${summarizeProcessError(error)}`;
}

function satisfiesSpecifier(version: string, specifier: string): boolean {
  if (!specifier) {
    return true;
  }
  const match = specifier.match(/^(===|~=|==|!=|<=|>=|<|>)\s*([0-9]+(?:\.[0-9]+){0,2})/);
  if (!match) {
    return true;
  }
  const [, operator, expected] = match;
  const comparison = compareVersions(version, expected);
  switch (operator) {
    case '>=':
      return comparison >= 0;
    case '>':
      return comparison > 0;
    case '<=':
      return comparison <= 0;
    case '<':
      return comparison < 0;
    case '==':
    case '===':
      return comparison === 0;
    case '!=':
      return comparison !== 0;
    case '~=':
      return comparison >= 0 && compareVersions(version, compatibleUpperBound(expected)) < 0;
    default:
      return true;
  }
}

function compatibleUpperBound(version: string): string {
  const parts = parseVersion(version);
  if (version.split('.').length <= 1) {
    return `${parts[0] + 1}.0.0`;
  }
  return `${parts[0]}.${parts[1] + 1}.0`;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

function majorMinor(version: string): string {
  const [major, minor] = parseVersion(version);
  return `${major}.${minor}`;
}

function requirementFromFailures(failures: string[]): string {
  const match = failures.join('\n').match(/taproot-mcp requires ([^\n]+)/);
  if (!match) {
    return '';
  }
  const requirement = match[1].trim();
  return requirement.endsWith('.') ? requirement.slice(0, -1) : requirement;
}

function describeCommand(command: CommandSpec): string {
  return [command.command, ...command.args].join(' ');
}

function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
