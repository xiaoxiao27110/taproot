import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export type NodeStatus = 'online' | 'warn' | 'error' | 'inactive' | 'checking';

export interface UiDefaults {
  user: string;
  port: string;
  pwd: string;
  sudo: string;
  extra: Record<string, unknown>;
}

export interface UiNode {
  id: number;
  name: string;
  host: string;
  user: string;
  port: string;
  pwd: string;
  sudo: string;
  tags: string[];
  status: NodeStatus;
  error?: string;
  extra: Record<string, unknown>;
}

export interface BackendStatus {
  connected: boolean;
  message: string;
}

export interface ServerStatus {
  running: boolean;
  url: string;
}

export interface ActivityItem {
  id: string;
  timestamp: string;
  node: string;
  tool: string;
  action: string;
  ok: boolean;
  summary: string;
  detail: Record<string, unknown>;
  error?: string;
}

export type ApprovalDecision = 'approve' | 'remember' | 'reject';

export interface ApprovalItem {
  id: string;
  status: string;
  tool: string;
  target: string;
  details: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface DashboardState {
  configPath: string;
  defaults: UiDefaults;
  nodes: UiNode[];
  backend: BackendStatus;
  server?: ServerStatus;
  activities: ActivityItem[];
  approvals: ApprovalItem[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const DEFAULTS: UiDefaults = {
  user: 'admin',
  port: '22',
  pwd: '',
  sudo: '',
  extra: {},
};

const DEFAULT_KEYS = new Set(['host', 'user', 'port', 'password', 'sudo_password']);
const NODE_KEYS = new Set(['host', 'user', 'port', 'password', 'sudo_password', 'tags']);

export function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.config', 'taproot', 'nodes.yaml');
}

export function parseNodesYaml(text: string, configPath: string, backend: BackendStatus): DashboardState {
  const raw = (yaml.load(text) ?? {}) as Record<string, unknown>;
  const rawDefaults = asRecord(raw.defaults);
  const rawNodes = asRecord(raw.nodes);

  const defaults: UiDefaults = {
    user: stringValue(rawDefaults.user, DEFAULTS.user),
    port: stringValue(rawDefaults.port, DEFAULTS.port),
    pwd: stringValue(rawDefaults.password, ''),
    sudo: stringValue(rawDefaults.sudo_password, ''),
    extra: pickExtra(rawDefaults, DEFAULT_KEYS),
  };

  const nodes: UiNode[] = Object.entries(rawNodes).map(([name, value], index) => {
    const node = asRecord(value);
    return {
      id: index + 1,
      name,
      host: stringValue(node.host, stringValue(rawDefaults.host, '')),
      user: stringValue(node.user, ''),
      port: stringValue(node.port, ''),
      pwd: stringValue(node.password, ''),
      sudo: stringValue(node.sudo_password, ''),
      tags: Array.isArray(node.tags) ? node.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      status: 'inactive',
      extra: pickExtra(node, NODE_KEYS),
    };
  });

  return { configPath, defaults, nodes, backend, activities: [], approvals: [] };
}

export function emptyState(configPath: string, backend: BackendStatus): DashboardState {
  return {
    configPath,
    defaults: { ...DEFAULTS, extra: {} },
    nodes: [],
    backend,
    activities: [],
    approvals: [],
  };
}

export function serializeNodesYaml(state: DashboardState): string {
  const defaults: Record<string, unknown> = { ...state.defaults.extra };
  setIfValue(defaults, 'user', state.defaults.user);
  setIfValue(defaults, 'port', numberOrString(state.defaults.port));
  setIfValue(defaults, 'password', state.defaults.pwd);
  setIfValue(defaults, 'sudo_password', state.defaults.sudo);

  const nodes: Record<string, unknown> = {};
  for (const node of state.nodes) {
    const entry: Record<string, unknown> = { ...node.extra };
    entry.host = node.host;
    setIfValue(entry, 'user', node.user);
    setIfValue(entry, 'port', numberOrString(node.port));
    setIfValue(entry, 'password', node.pwd);
    setIfValue(entry, 'sudo_password', node.sudo);
    if (node.tags.length > 0) {
      entry.tags = node.tags;
    } else {
      delete entry.tags;
    }
    nodes[node.name] = entry;
  }

  return yaml.dump({ defaults, nodes }, { lineWidth: 100, noRefs: true, sortKeys: false });
}

export function validateState(state: DashboardState): ValidationResult {
  const errors: string[] = [];
  const names = state.nodes.map((node) => node.name.trim()).filter(Boolean);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }

  for (const node of state.nodes) {
    const label = node.name.trim() || `node-${node.id}`;
    if (!node.name.trim()) {
      errors.push(`节点 ${node.id} 缺少名称`);
    }
    if (!node.host.trim()) {
      errors.push(`${label}: host 必填`);
    }
    if (duplicates.has(node.name.trim())) {
      errors.push(`${label}: 节点名称重复`);
    }
    for (const [field, value] of [
      ['defaults.port', state.defaults.port],
      [`${label}.port`, node.port],
    ] as const) {
      if (value && !/^[0-9]+$/.test(value)) {
        errors.push(`${field} 必须是数字`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function makeSshCommand(defaults: UiDefaults, node: UiNode): string {
  const connection = resolveSshConnection(defaults, node);
  return `ssh -p ${shellQuote(connection.port)} ${shellQuote(connection.destination)}`;
}

export function makeSshpassCommand(defaults: UiDefaults, node: UiNode): string {
  return `sshpass -e ${makeSshCommand(defaults, node)}`;
}

export function resolveSshConnection(defaults: UiDefaults, node: UiNode): {
  port: string;
  destination: string;
  password: string;
} {
  const user = node.user || defaults.user;
  const port = node.port || defaults.port || '22';
  const destination = user ? `${user}@${node.host}` : node.host;
  return {
    port,
    destination,
    password: node.pwd || defaults.pwd || '',
  };
}

export function stateForSerialization(state: DashboardState): DashboardState {
  return {
    configPath: state.configPath,
    defaults: { ...state.defaults, extra: state.defaults.extra ?? {} },
    nodes: state.nodes.map((node, index) => ({
      ...node,
      id: node.id || index + 1,
      tags: node.tags ?? [],
      extra: node.extra ?? {},
    })),
    backend: state.backend,
    server: state.server,
    activities: state.activities ?? [],
    approvals: state.approvals ?? [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function pickExtra(source: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

function setIfValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    delete target[key];
    return;
  }
  target[key] = value;
}

function numberOrString(value: string): number | string {
  return /^[0-9]+$/.test(value) ? Number(value) : value;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
