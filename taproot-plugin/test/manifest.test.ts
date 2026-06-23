import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..', '..');

test('extension manifest contributes a taproot-mcp activity bar view', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const extensionSource = await readFile(path.join(root, 'src', 'extension.ts'), 'utf8');
  const contributes = manifest.contributes;

  assert(contributes.viewsContainers.activitybar.some((item: { id: string }) => item.id === 'taproot'));
  assert(contributes.views.taproot.some((item: { id: string }) => item.id === 'taproot.nodes'));
  assert.equal(contributes.icons['taproot-root'].default.fontPath, './media/taproot-icons.woff');
  assert.equal(contributes.icons['taproot-root'].default.fontCharacter, '\\F101');
  assert(manifest.activationEvents.includes('onView:taproot.nodes'));
  assert(manifest.activationEvents.includes('onCommand:taproot.openConfig'));
  assert.equal(contributes.configuration.properties['taproot.statusPollIntervalSeconds'].default, 60);
  assert(!contributes.menus['view/title'].some((item: { command: string }) => item.command === 'taproot.openDashboard'));
  assert(!contributes.menus['view/title'].some((item: { command: string }) => item.command === 'taproot.testConnections'));
  assert(contributes.menus['view/title'].some((item: { command: string }) => item.command === 'taproot.openConfig'));
  assert(contributes.menus['view/item/context'].some((item: { command: string }) => item.command === 'taproot.openNodeTerminal'));
  assert.equal(manifest.name, 'taproot-mcp');
  assert.equal(manifest.displayName, 'taproot-mcp');
  assert(extensionSource.includes("status.text = '$(taproot-root) taproot-mcp';"));
  assert(!extensionSource.includes("status.text = '$(person) taproot-mcp';"));
  assert(!extensionSource.includes("status.text = '$(remote) taproot-mcp';"));
  const existingPanelBlock = extensionSource.match(/if \(this\.panel\) \{([\s\S]*?)return;\n    \}/)?.[1] || '';
  assert(existingPanelBlock.includes('this.panel.reveal(vscode.ViewColumn.One);'));
  assert(existingPanelBlock.includes('this.flushPendingSelection();'));
  assert(!existingPanelBlock.includes('reloadState()'));
  const currentStateBlock = extensionSource.match(/async currentState\(\): Promise<DashboardState> \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert(!currentStateBlock.includes('scheduleAutoCheck'));
  assert(extensionSource.includes('dashboard.startStatusPolling();'));
  assert(extensionSource.includes("this.post({ type: 'statusUpdate', state: checked });"));
  assert(extensionSource.includes('this.suppressNextAutoCheck = true;'));
  assert.match(extensionSource, /async reloadState\(\): Promise<DashboardState> \{[\s\S]*?await this\.postState\(state\);[\s\S]*?this\.stateEmitter\.fire\(\);/);
});
