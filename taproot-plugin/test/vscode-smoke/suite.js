const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('xiaoxiao27110.taproot-mcp');
  assert(extension, 'Taproot MCP extension is not registered in the extension host');

  const configPath = process.env.TAPROOT_TEST_CONFIG;
  const config = vscode.workspace.getConfiguration('taproot');
  if (configPath) {
    await config.update('configPath', configPath, vscode.ConfigurationTarget.Global);
  }
  await config.update('statusPollIntervalSeconds', 0, vscode.ConfigurationTarget.Global);

  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'taproot.openDashboard',
    'taproot.openConfig',
    'taproot.testConnections',
    'taproot.refreshNodes',
    'taproot.openNodeTerminal',
    'taproot.copyNodeSsh',
    'workbench.view.extension.taproot',
    'taproot.nodes.focus',
  ]) {
    assert(commands.includes(command), `${command} is not registered`);
  }

  await vscode.commands.executeCommand('workbench.view.extension.taproot');
  await vscode.commands.executeCommand('taproot.nodes.focus');
  await vscode.commands.executeCommand('taproot.refreshNodes');
  if (process.env.TAPROOT_RUN_CONNECTION_TEST === '1') {
    await vscode.commands.executeCommand('taproot.testConnections');
  }
  await vscode.commands.executeCommand('taproot.openConfig');
  await vscode.commands.executeCommand('taproot.openDashboard');
}

module.exports = { run };
