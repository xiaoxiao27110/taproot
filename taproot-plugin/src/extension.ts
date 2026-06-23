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
  makeSshpassCommand,
  parseNodesYaml,
  resolveSshConnection,
  serializeNodesYaml,
  stateForSerialization,
  validateState,
} from './configModel';

interface WebviewMessage {
  type: string;
  state?: DashboardState;
  nodeName?: string;
  command?: string;
  view?: 'config' | 'detail';
}

interface TaprootTreeNode {
  nodeName?: string;
}

const BUNDLED_BACKEND_WHEEL = 'taproot_mcp-0.2.1-py3-none-any.whl';

export function activate(context: vscode.ExtensionContext): void {
  const dashboard = new TaprootDashboard(context);
  void vscode.commands.executeCommand('setContext', 'taproot.serverRunning', false);
  dashboard.startStatusPolling();
  const treeProvider = new TaprootNodesProvider(dashboard);
  const treeView = vscode.window.createTreeView('taproot.nodes', {
    treeDataProvider: treeProvider,
  });

  context.subscriptions.push(
    treeView,
    dashboard.onDidChangeState(() => treeProvider.refresh()),
    vscode.commands.registerCommand('taproot.openDashboard', (item?: TaprootTreeNode | string) => {
      const nodeName = typeof item === 'string' ? item : item?.nodeName;
      return dashboard.open(nodeName);
    }),
    vscode.commands.registerCommand('taproot.openConfig', (item?: TaprootTreeNode | string) => {
      const nodeName = typeof item === 'string' ? item : item?.nodeName;
      return dashboard.openConfig(nodeName);
    }),
    vscode.commands.registerCommand('taproot.testConnections', async () => {
      await dashboard.testActiveState();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('taproot.refreshNodes', () => dashboard.reloadState()),
    vscode.commands.registerCommand('taproot.installBackend', () => dashboard.installBackend()),
    vscode.commands.registerCommand('taproot.startServer', () => dashboard.startHttpServer()),
    vscode.commands.registerCommand('taproot.stopServer', () => dashboard.stopHttpServer()),
    vscode.commands.registerCommand('taproot.openNodeTerminal', async (item?: TaprootTreeNode) => {
      await dashboard.openTerminalForNode(item?.nodeName);
    }),
    vscode.commands.registerCommand('taproot.copyNodeSsh', async (item?: TaprootTreeNode) => {
      await dashboard.copySshForNode(item?.nodeName);
    }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'taproot.openDashboard';
  status.text = '$(taproot-root) taproot-mcp';
  status.tooltip = 'Open taproot-mcp dashboard';
  status.show();
  context.subscriptions.push(status);
}

export function deactivate(): void {
  // Nothing to dispose explicitly; subscriptions own all VS Code resources.
}

class TaprootDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private lastState: DashboardState | undefined;
  private pendingNodeName: string | undefined;
  private pendingView: 'config' | undefined;
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private autoCheckPromise: Promise<DashboardState> | undefined;
  private suppressNextAutoCheck = false;
  private statusPollTimer: NodeJS.Timeout | undefined;
  private serverProcess: cp.ChildProcess | undefined;

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push({ dispose: () => this.stopStatusPolling() });
    this.context.subscriptions.push({ dispose: () => void this.stopHttpServer({ silent: true }) });
  }

  startStatusPolling(): void {
    if (this.statusPollTimer) {
      return;
    }
    const intervalMs = this.statusPollIntervalMs();
    if (intervalMs <= 0) {
      return;
    }
    this.statusPollTimer = setInterval(() => {
      void this.pollConnectionStatus();
    }, intervalMs);
    setTimeout(() => {
      void this.pollConnectionStatus();
    }, 1_000);
  }

  stopStatusPolling(): void {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = undefined;
    }
  }

  async open(nodeName?: string): Promise<void> {
    if (nodeName) {
      this.pendingNodeName = nodeName;
      this.suppressNextAutoCheck = true;
    }

    await revealTaprootSidebar();

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.flushPendingSelection();
      this.flushPendingView();
      this.suppressNextAutoCheck = false;
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'taprootDashboard',
      'taproot-mcp Nodes',
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
    const state = this.lastState ?? await this.loadState();
    await this.runConnectionCheck(state);
  }

  async openConfig(nodeName?: string): Promise<void> {
    this.pendingView = 'config';
    await this.open(nodeName);
  }

  async reloadState(): Promise<DashboardState> {
    const state = await this.loadState();
    await this.postState(state);
    this.stateEmitter.fire();
    this.scheduleAutoCheck(state, { silent: false });
    return state;
  }

  async currentState(): Promise<DashboardState> {
    const state = this.lastState ?? await this.loadState();
    return state;
  }

  async openTerminalForNode(nodeName: string | undefined): Promise<void> {
    await this.openTerminal(await this.loadState(), nodeName);
  }

  async copySshForNode(nodeName: string | undefined): Promise<void> {
    await this.copySsh(await this.loadState(), nodeName);
  }

  async installBackend(): Promise<void> {
    try {
      const python = await resolvePythonCommand(this.pythonCommand());
      const installSource = await this.backendInstallSource();
      let installedCommand = '';
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在安装/更新 Taproot 后端',
          cancellable: false,
        },
        async () => {
          await runProcess(
            python.command,
            [...python.args, ...(await taprootInstallArgs(python, installSource))],
            180_000,
          );
          installedCommand = await resolveInstalledTaprootCommand(python);
        },
      );

      if (installedCommand) {
        await this.configureTaprootCommand(installedCommand);
      }

      const state = await this.loadState();
      await this.postState(state);
      const message = installedCommand
        ? `Taproot 后端已安装: ${installedCommand}`
        : 'Taproot 后端已安装。如果面板仍然找不到 taproot-mcp，请设置 taproot.taprootMcpCommand。';
      this.post({ type: 'backendInstalled', state, message });
      this.stateEmitter.fire();
      vscode.window.showInformationMessage(message);
    } catch (error) {
      const message = `Taproot 后端安装失败: ${formatError(error)}`;
      this.post({ type: 'error', message });
      vscode.window.showErrorMessage(message);
    }
  }

  async startHttpServer(): Promise<void> {
    if (this.serverProcess) {
      vscode.window.showInformationMessage(`Taproot MCP server is already running at ${this.serverUrl()}`);
      return;
    }

    const configPath = this.resolveConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    try {
      await fs.access(configPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        await this.createInitialConfig(emptyState(configPath, await this.checkBackend()));
      } else {
        throw error;
      }
    }

    const command = this.taprootCommand();
    const args = [
      'serve',
      '--config',
      configPath,
      '--transport',
      'http',
      '--host',
      this.httpHost(),
      '--port',
      String(this.httpPort()),
    ];
    const child = cp.spawn(command, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      this.serverProcess = undefined;
      void vscode.commands.executeCommand('setContext', 'taproot.serverRunning', false);
      vscode.window.showErrorMessage(`Taproot MCP server failed to start: ${formatError(error)}`);
    });
    child.on('close', (code) => {
      if (this.serverProcess === child) {
        this.serverProcess = undefined;
        void vscode.commands.executeCommand('setContext', 'taproot.serverRunning', false);
      }
      if (code !== null && code !== 0) {
        const detail = output.trim();
        vscode.window.showErrorMessage(`Taproot MCP server exited (${code})${detail ? `: ${detail}` : ''}`);
      }
    });

    this.serverProcess = child;
    await vscode.commands.executeCommand('setContext', 'taproot.serverRunning', true);
    vscode.window.showInformationMessage(`Taproot MCP server started: ${this.serverUrl()}`);
  }

  async stopHttpServer(options: { silent?: boolean } = {}): Promise<void> {
    const child = this.serverProcess;
    if (!child) {
      if (!options.silent) {
        vscode.window.showInformationMessage('Taproot MCP server is not running.');
      }
      return;
    }
    this.serverProcess = undefined;
    child.kill();
    await vscode.commands.executeCommand('setContext', 'taproot.serverRunning', false);
    if (!options.silent) {
      vscode.window.showInformationMessage('Taproot MCP server stopped.');
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.postState(await this.loadState());
          if (this.lastState && !this.consumeAutoCheckSuppression()) {
            this.scheduleAutoCheck(this.lastState, { silent: true });
          }
          this.flushPendingSelection();
          this.flushPendingView();
          break;
        case 'saveConfig':
          await this.saveConfig(requiredState(message));
          break;
        case 'resetConfig':
          await this.postState(await this.loadState());
          if (this.lastState) {
            this.scheduleAutoCheck(this.lastState);
          }
          break;
        case 'installBackend':
          await this.installBackend();
          break;
        case 'testConnections':
          await this.runConnectionCheck(requiredState(message));
          break;
        case 'testNode':
          await this.runConnectionCheck(requiredState(message), message.nodeName);
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
      const state = {
        ...parseNodesYaml(text, configPath, backend),
        activities: await this.loadHistory(configPath),
      };
      this.lastState = state;
      return state;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        const state = emptyState(configPath, backend);
        await this.createInitialConfig(state);
        this.lastState = state;
        return state;
      } else {
        vscode.window.showWarningMessage(`Taproot config load failed: ${formatError(error)}`);
      }
      const state = emptyState(configPath, backend);
      this.lastState = state;
      return state;
    }
  }

  private async createInitialConfig(state: DashboardState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(state.configPath), { recursive: true });
      await fs.writeFile(state.configPath, serializeNodesYaml(state), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        return;
      }
      vscode.window.showWarningMessage(`Taproot config create failed: ${formatError(error)}`);
    }
  }

  private async loadHistory(configPath: string): Promise<DashboardState['activities']> {
    try {
      const output = await runProcess(
        this.taprootCommand(),
        ['history', '--config', configPath, '--limit', '200'],
        10_000,
      );
      const parsed = JSON.parse(output.stdout);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((item): item is DashboardState['activities'][number] =>
          item &&
          typeof item.id === 'string' &&
          typeof item.node === 'string' &&
          typeof item.tool === 'string' &&
          typeof item.summary === 'string',
        )
        .slice(0, 200);
    } catch {
      return [];
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
    this.stateEmitter.fire();
  }

  private async pollConnectionStatus(): Promise<void> {
    if (this.autoCheckPromise) {
      return;
    }
    const state = await this.loadState();
    if (!state.backend.connected || state.nodes.length === 0) {
      this.post({ type: 'statusUpdate', state });
      this.stateEmitter.fire();
      return;
    }
    this.scheduleAutoCheck(state, { silent: true });
  }

  private async runConnectionCheck(
    rawState: DashboardState,
    nodeName?: string,
    options: { silent?: boolean } = {},
  ): Promise<DashboardState> {
    const state = stateForSerialization(rawState);
    const targetNodes = nodeName ? state.nodes.filter((node) => node.name === nodeName) : state.nodes;
    if (nodeName && targetNodes.length === 0) {
      throw new Error(`未找到节点: ${nodeName}`);
    }
    const checkState = nodeName ? { ...state, nodes: targetNodes } : state;
    const validation = validateState(checkState);
    if (!validation.ok) {
      this.post({ type: 'validation', errors: validation.errors });
      return state;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taproot-mcp-'));
    const tmpConfig = path.join(tmpDir, 'nodes.yaml');
    await fs.writeFile(tmpConfig, serializeNodesYaml(checkState), 'utf8');

    try {
      const command = this.taprootCommand();
      const output = await runProcess(command, ['check', '--config', tmpConfig], 45_000);
      const statuses = parseCheckOutput(output.stdout + output.stderr);
      const nodes = state.nodes.map((node) => {
        if (nodeName && node.name !== nodeName) {
          return node;
        }
        const status = statuses.get(node.name);
        if (!status) {
          return { ...node, status: 'error' as const, error: '未返回连接结果' };
        }
        return status.ok
          ? { ...node, status: 'online' as const, error: undefined }
          : { ...node, status: 'error' as const, error: status.error || '连接失败' };
      });
      const checked = {
        ...state,
        nodes,
        backend: await this.checkBackend(),
        activities: await this.loadHistory(state.configPath),
      };
      this.lastState = checked;
      if (options.silent) {
        this.post({ type: 'statusUpdate', state: checked });
      } else {
        this.post({
          type: 'testResults',
          state: checked,
          message: testResultMessage(nodes, nodeName),
        });
      }
      this.stateEmitter.fire();
      return checked;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private scheduleAutoCheck(state: DashboardState, options: { silent?: boolean } = {}): void {
    if (this.autoCheckPromise || !state.backend.connected || state.nodes.length === 0) {
      return;
    }
    if (!state.nodes.some((node) => node.status === 'inactive' || node.status === 'checking')) {
      return;
    }
    this.autoCheckPromise = this.runConnectionCheck(state, undefined, options)
      .catch((error) => {
        if (!options.silent) {
          this.post({ type: 'error', message: formatError(error) });
        }
        return state;
      })
      .finally(() => {
        this.autoCheckPromise = undefined;
      });
  }

  private async openTerminal(rawState: DashboardState, nodeName: string | undefined): Promise<void> {
    const state = stateForSerialization(rawState);
    const node = findNode(state, nodeName);
    if (!node) {
      throw new Error('未选择节点');
    }
    const command = makeSshCommand(state.defaults, node);
    const connection = resolveSshConnection(state.defaults, node);
    let terminalCommand = command;
    let terminalEnv: Record<string, string> | undefined;
    let message = `终端执行: ${command}`;

    if (connection.password) {
      const passwordTool = await detectSshPasswordTool();
      if (passwordTool === 'sshpass') {
        terminalCommand = `${makeSshpassCommand(state.defaults, node)}; unset SSHPASS`;
        terminalEnv = { SSHPASS: connection.password };
        message = `正在用配置密码连接: ${command}`;
      } else if (passwordTool === 'expect') {
        const expectScript = await writeExpectSshScript();
        terminalCommand = `expect ${shellQuote(expectScript)}; unset TAPROOT_SSH_PASSWORD TAPROOT_SSH_PORT TAPROOT_SSH_DESTINATION`;
        terminalEnv = {
          TAPROOT_SSH_DESTINATION: connection.destination,
          TAPROOT_SSH_PASSWORD: connection.password,
          TAPROOT_SSH_PORT: connection.port,
        };
        message = `正在用配置密码连接: ${command}`;
      } else {
        message = '已打开 SSH 终端；当前系统没有 sshpass/expect，仍需手动输入密码。建议配置 SSH key。';
      }
    }

    const terminal = vscode.window.createTerminal({
      name: `Taproot: ${node.name}`,
      env: terminalEnv,
    });
    terminal.show();
    terminal.sendText(terminalCommand);
    this.post({ type: 'toast', message });
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

  private async postState(state: DashboardState): Promise<boolean> {
    this.lastState = state;
    if (!this.panel) {
      return false;
    }
    const delivered = await this.panel.webview.postMessage({ type: 'state', state });
    if (!delivered) {
      this.panel.webview.html = this.html(this.panel.webview);
    }
    return delivered;
  }

  private post(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  private flushPendingSelection(): void {
    if (!this.pendingNodeName) {
      return;
    }
    const view = this.pendingView === 'config' ? 'config' : undefined;
    this.post({ type: 'selectNode', nodeName: this.pendingNodeName, view });
    this.pendingNodeName = undefined;
    if (view) {
      this.pendingView = undefined;
    }
  }

  private flushPendingView(): void {
    if (!this.pendingView) {
      return;
    }
    this.post({ type: 'showConfig' });
    this.pendingView = undefined;
  }

  private consumeAutoCheckSuppression(): boolean {
    const suppressed = this.suppressNextAutoCheck;
    this.suppressNextAutoCheck = false;
    return suppressed;
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

  private pythonCommand(): string {
    return vscode.workspace.getConfiguration('taproot').get<string>('pythonCommand')?.trim() || '';
  }

  private async backendInstallSource(): Promise<string> {
    const wheelPath = vscode.Uri.joinPath(this.context.extensionUri, 'backend', BUNDLED_BACKEND_WHEEL).fsPath;
    try {
      await fs.access(wheelPath);
      return wheelPath;
    } catch {
      return 'taproot-mcp';
    }
  }

  private async configureTaprootCommand(commandPath: string): Promise<void> {
    try {
      await fs.access(commandPath);
    } catch {
      return;
    }
    const configuration = vscode.workspace.getConfiguration('taproot');
    const configured = configuration.get<string>('taprootMcpCommand')?.trim();
    if (configured && configured !== 'taproot-mcp') {
      return;
    }
    const inspected = configuration.inspect<string>('taprootMcpCommand');
    const target = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await configuration.update('taprootMcpCommand', commandPath, target);
  }

  private httpHost(): string {
    return vscode.workspace.getConfiguration('taproot').get<string>('httpHost')?.trim() || '127.0.0.1';
  }

  private httpPort(): number {
    const port = vscode.workspace.getConfiguration('taproot').get<number>('httpPort') ?? 8765;
    return Number.isInteger(port) && port > 0 ? port : 8765;
  }

  private serverUrl(): string {
    return `http://${this.httpHost()}:${this.httpPort()}/mcp`;
  }

  private statusPollIntervalMs(): number {
    const seconds = vscode.workspace.getConfiguration('taproot').get<number>('statusPollIntervalSeconds') ?? 60;
    return Math.max(0, seconds) * 1_000;
  }

  private async checkBackend() {
    const command = this.taprootCommand();
    try {
      await runProcess(command, ['--help'], 10_000);
      return { connected: true, message: 'taproot-mcp 已连接' };
    } catch (error) {
      return { connected: false, message: formatBackendUnavailable(command, error) };
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
  <title>taproot-mcp Nodes</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function testResultMessage(nodes: DashboardState['nodes'], nodeName?: string): string {
  const scopedNodes = nodeName ? nodes.filter((node) => node.name === nodeName) : nodes;
  const successCount = scopedNodes.filter((node) => node.status === 'online').length;
  const totalCount = scopedNodes.length;
  return `${nodeName ? '刷新完成' : '测试完成'}：成功 ${successCount} / 共 ${totalCount} 个节点`;
}

class TaprootNodesProvider implements vscode.TreeDataProvider<TaprootTreeItem> {
  private readonly emitter = new vscode.EventEmitter<TaprootTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly dashboard: TaprootDashboard) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TaprootTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TaprootTreeItem): Promise<TaprootTreeItem[]> {
    if (element) {
      return [];
    }

    try {
      const state = await this.dashboard.currentState();
      if (state.nodes.length === 0) {
        return [new TaprootMessageItem('No nodes configured', state.configPath)];
      }
      return state.nodes.map((node) => new TaprootNodeItem(node, state));
    } catch (error) {
      return [new TaprootMessageItem('Failed to load nodes', formatError(error))];
    }
  }
}

type TaprootTreeItem = TaprootNodeItem | TaprootMessageItem;

interface CommandSpec {
  command: string;
  args: string[];
}

class TaprootNodeItem extends vscode.TreeItem implements TaprootTreeNode {
  readonly nodeName: string;

  constructor(node: DashboardState['nodes'][number], state: DashboardState) {
    super(node.name, vscode.TreeItemCollapsibleState.None);
    this.nodeName = node.name;
    this.contextValue = 'taprootNode';
    this.description = `${node.user || state.defaults.user}@${node.host || '未配置'}`;
    this.tooltip = [
      `Host: ${node.host || '未配置'}`,
      `Port: ${node.port || state.defaults.port || '22'}`,
      `Tags: ${node.tags.join(', ') || '-'}`,
      node.error ? `Error: ${node.error}` : undefined,
    ].filter(Boolean).join('\n');
    this.iconPath = statusThemeIcon(node.status);
    this.command = {
      command: 'taproot.openConfig',
      title: 'Edit taproot-mcp Node Config',
      arguments: [node.name],
    };
  }
}

class TaprootMessageItem extends vscode.TreeItem {
  constructor(label: string, detail: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon('info');
    this.command = {
      command: 'taproot.openDashboard',
      title: 'Open taproot-mcp Dashboard',
    };
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

async function resolvePythonCommand(configuredCommand: string): Promise<CommandSpec> {
  const candidates = pythonCandidates(configuredCommand);
  for (const candidate of candidates) {
    try {
      await runProcess(candidate.command, [...candidate.args, '-c', 'import sys; print(sys.executable)'], 10_000);
      return candidate;
    } catch {
      // Try the next common Python launcher.
    }
  }
  throw new Error('No Python command found. Install Python or set taproot.pythonCommand.');
}

async function taprootInstallArgs(python: CommandSpec, installSource: string): Promise<string[]> {
  const args = ['-m', 'pip', 'install', '--upgrade'];
  if (!(await pythonUsesVirtualEnv(python))) {
    args.push('--user');
  }
  args.push(installSource);
  return args;
}

async function pythonUsesVirtualEnv(python: CommandSpec): Promise<boolean> {
  const code = 'import sys; print(int(getattr(sys, "base_prefix", sys.prefix) != sys.prefix))';
  try {
    const output = await runProcess(python.command, [...python.args, '-c', code], 10_000);
    return output.stdout.trim().split(/\r?\n/).pop() === '1';
  } catch {
    return false;
  }
}

function pythonCandidates(configuredCommand: string): CommandSpec[] {
  const candidates: CommandSpec[] = [];
  if (configuredCommand) {
    candidates.push({ command: expandHome(configuredCommand), args: [] });
  }
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', args: ['-3'] });
    candidates.push({ command: 'python', args: [] });
    candidates.push({ command: 'python3', args: [] });
  } else {
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

async function resolveInstalledTaprootCommand(python: CommandSpec): Promise<string> {
  const code = [
    'import os, shutil, site, sysconfig',
    'name = "taproot-mcp.exe" if os.name == "nt" else "taproot-mcp"',
    'candidates = []',
    'found = shutil.which(name)',
    'candidates.append(found)',
    'schemes = [sysconfig.get_default_scheme(), f"{os.name}_user"]',
    'for scheme in schemes:',
    '    try:',
    '        candidates.append(os.path.join(sysconfig.get_path("scripts", scheme=scheme) or "", name))',
    '    except Exception:',
    '        pass',
    'try:',
    '    candidates.append(os.path.join(site.getuserbase(), "Scripts" if os.name == "nt" else "bin", name))',
    'except Exception:',
    '    pass',
    'for candidate in candidates:',
    '    if candidate and os.path.exists(candidate):',
    '        print(os.path.abspath(candidate))',
    '        break',
  ].join('\n');
  try {
    const output = await runProcess(python.command, [...python.args, '-c', code], 10_000);
    const candidate = output.stdout.trim().split(/\r?\n/).pop() || '';
    if (!candidate) {
      return '';
    }
    await fs.access(candidate);
    return candidate;
  } catch {
    return '';
  }
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

type SshPasswordTool = 'sshpass' | 'expect' | undefined;

let sshPasswordToolPromise: Promise<SshPasswordTool> | undefined;

function detectSshPasswordTool(): Promise<SshPasswordTool> {
  if (!sshPasswordToolPromise) {
    sshPasswordToolPromise = (async () => {
      if (await commandExists('sshpass')) {
        return 'sshpass';
      }
      if (await commandExists('expect')) {
        return 'expect';
      }
      return undefined;
    })();
  }
  return sshPasswordToolPromise;
}

async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await runProcess(probe, [command], 2_000);
    return true;
  } catch {
    return false;
  }
}

async function writeExpectSshScript(): Promise<string> {
  const scriptPath = path.join(os.tmpdir(), 'taproot-mcp-ssh-login.exp');
  await fs.writeFile(scriptPath, expectSshScript(), { encoding: 'utf8', mode: 0o700 });
  return scriptPath;
}

function expectSshScript(): string {
  return `#!/usr/bin/expect -f
set timeout 20
spawn ssh -p $env(TAPROOT_SSH_PORT) $env(TAPROOT_SSH_DESTINATION)
expect {
  -re {Are you sure you want to continue connecting.*} {
    send "yes\\r"
    exp_continue
  }
  -re {[Pp]assword:} {
    send -- "$env(TAPROOT_SSH_PASSWORD)\\r"
    interact
  }
  timeout {
    interact
  }
  eof {
    exit
  }
}
`;
}

async function revealTaprootSidebar(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.taproot');
  } catch {
    // Older VS Code builds may not expose the generated focus command immediately.
  }
}

function statusThemeIcon(status: DashboardState['nodes'][number]['status']): vscode.ThemeIcon {
  switch (status) {
    case 'online':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'warn':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'checking':
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
    case 'inactive':
    default:
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBackendUnavailable(command: string, error: unknown): string {
  if (isMissingCommandError(command, error)) {
    return [
      `taproot-mcp 不可用: 找不到命令 "${command}"。`,
      '请点击 Install/Update Backend 安装后端，',
      '或在扩展运行的同一环境安装 taproot-mcp。',
      'Remote-SSH 场景下应安装在 SSH 远端。',
    ].join('');
  }
  return `taproot-mcp 不可用: ${formatError(error)}`;
}

function isMissingCommandError(command: string, error: unknown): boolean {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === 'ENOENT') {
    return true;
  }
  const message = formatError(error).toLowerCase();
  return (
    message.includes(`${command.toLowerCase()}: command not found`) ||
    message.includes(`${command.toLowerCase()}: not found`) ||
    message.includes(`'${command.toLowerCase()}' is not recognized`) ||
    message.startsWith(`'${command.toLowerCase()}' `)
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
