import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  DashboardState,
  defaultConfigPath,
  emptyState,
  expandHome,
  makeSshCommand,
  parseNodesYaml,
  serializeNodesYaml,
  stateForSerialization,
  validateState,
} from './configModel';

interface WebviewMessage {
  type: string;
  state?: DashboardState;
  nodeName?: string;
  command?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const dashboard = new TaprootDashboard(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('taproot.openDashboard', () => dashboard.open()),
    vscode.commands.registerCommand('taproot.testConnections', () => dashboard.testActiveState()),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'taproot.openDashboard';
  status.text = '$(remote) Taproot';
  status.tooltip = 'Open Taproot dashboard';
  status.show();
  context.subscriptions.push(status);
}

export function deactivate(): void {
  // Nothing to dispose explicitly; subscriptions own all VS Code resources.
}

class TaprootDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private lastState: DashboardState | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'taprootDashboard',
      'Taproot Nodes',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
      },
    );

    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }

  async testActiveState(): Promise<void> {
    if (!this.panel) {
      this.open();
      return;
    }
    const state = this.lastState ?? await this.loadState();
    await this.runConnectionCheck(state);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.postState(await this.loadState());
          break;
        case 'saveConfig':
          await this.saveConfig(requiredState(message));
          break;
        case 'resetConfig':
          await this.postState(await this.loadState());
          break;
        case 'testConnections':
          await this.runConnectionCheck(requiredState(message));
          break;
        case 'openTerminal':
          await this.openTerminal(requiredState(message), message.nodeName);
          break;
        case 'copySsh':
          await this.copySsh(requiredState(message), message.nodeName);
          break;
        default:
          this.post({ type: 'error', message: `Unknown message: ${message.type}` });
      }
    } catch (error) {
      this.post({ type: 'error', message: formatError(error) });
    }
  }

  private async loadState(): Promise<DashboardState> {
    const configPath = this.resolveConfigPath();
    const backend = await this.checkBackend();
    try {
      const text = await fs.readFile(configPath, 'utf8');
      const state = parseNodesYaml(text, configPath, backend);
      this.lastState = state;
      return state;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        vscode.window.showWarningMessage(`Taproot config load failed: ${formatError(error)}`);
      }
      const state = emptyState(configPath, backend);
      this.lastState = state;
      return state;
    }
  }

  private async saveConfig(rawState: DashboardState): Promise<void> {
    const state = stateForSerialization(rawState);
    const validation = validateState(state);
    if (!validation.ok) {
      this.post({ type: 'validation', errors: validation.errors });
      return;
    }

    await fs.mkdir(path.dirname(state.configPath), { recursive: true });
    await fs.writeFile(state.configPath, serializeNodesYaml(state), 'utf8');
    this.lastState = state;
    this.post({ type: 'saved', state, message: `已保存 ${state.configPath}` });
  }

  private async runConnectionCheck(rawState: DashboardState): Promise<void> {
    const state = stateForSerialization(rawState);
    const validation = validateState(state);
    if (!validation.ok) {
      this.post({ type: 'validation', errors: validation.errors });
      return;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taproot-vscode-'));
    const tmpConfig = path.join(tmpDir, 'nodes.yaml');
    await fs.writeFile(tmpConfig, serializeNodesYaml(state), 'utf8');

    try {
      const command = this.taprootCommand();
      const output = await runProcess(command, ['check', '--config', tmpConfig], 45_000);
      const statuses = parseCheckOutput(output.stdout + output.stderr);
      const nodes = state.nodes.map((node) => {
        const status = statuses.get(node.name);
        if (!status) {
          return { ...node, status: 'error' as const, error: '未返回连接结果' };
        }
        return status.ok
          ? { ...node, status: 'online' as const, error: undefined }
          : { ...node, status: 'error' as const, error: status.error || '连接失败' };
      });
      const checked = { ...state, nodes, backend: await this.checkBackend() };
      this.lastState = checked;
      this.post({ type: 'testResults', state: checked, message: `已测试 ${nodes.length} 个节点` });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async openTerminal(rawState: DashboardState, nodeName: string | undefined): Promise<void> {
    const state = stateForSerialization(rawState);
    const node = findNode(state, nodeName);
    if (!node) {
      throw new Error('未选择节点');
    }
    const command = makeSshCommand(state.defaults, node);
    const terminal = vscode.window.createTerminal({ name: `Taproot: ${node.name}` });
    terminal.show();
    terminal.sendText(command);
    this.post({ type: 'toast', message: `终端执行: ${command}` });
  }

  private async copySsh(rawState: DashboardState, nodeName: string | undefined): Promise<void> {
    const state = stateForSerialization(rawState);
    const node = findNode(state, nodeName);
    if (!node) {
      throw new Error('未选择节点');
    }
    const command = makeSshCommand(state.defaults, node);
    await vscode.env.clipboard.writeText(command);
    this.post({ type: 'toast', message: `已复制: ${command}` });
  }

  private async postState(state: DashboardState): Promise<void> {
    this.lastState = state;
    this.post({ type: 'state', state });
  }

  private post(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  private resolveConfigPath(): string {
    const configured = vscode.workspace.getConfiguration('taproot').get<string>('configPath')?.trim();
    if (configured) {
      return path.resolve(expandHome(configured));
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return defaultConfigPath(root);
  }

  private taprootCommand(): string {
    return vscode.workspace.getConfiguration('taproot').get<string>('taprootMcpCommand')?.trim() || 'taproot-mcp';
  }

  private async checkBackend() {
    try {
      await runProcess(this.taprootCommand(), ['--help'], 10_000);
      return { connected: true, message: 'taproot-mcp 已连接' };
    } catch (error) {
      return { connected: false, message: `taproot-mcp 不可用: ${formatError(error)}` };
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.css'));
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Taproot Nodes</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function requiredState(message: WebviewMessage): DashboardState {
  if (!message.state) {
    throw new Error(`${message.type} requires state`);
  }
  return message.state;
}

function findNode(state: DashboardState, nodeName: string | undefined) {
  return state.nodes.find((node) => node.name === nodeName) ?? state.nodes[0];
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `${command} exited ${code}`).trim()));
      }
    });
  });
}

function parseCheckOutput(output: string): Map<string, { ok: boolean; error?: string }> {
  const statuses = new Map<string, { ok: boolean; error?: string }>();
  for (const line of output.split(/\r?\n/)) {
    const ok = line.match(/^(.+?):\s+ok\s*$/);
    if (ok) {
      statuses.set(ok[1], { ok: true });
      continue;
    }
    const failed = line.match(/^(.+?):\s+failed\s+-\s+(.+)$/);
    if (failed) {
      statuses.set(failed[1], { ok: false, error: failed[2] });
    }
  }
  return statuses;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
