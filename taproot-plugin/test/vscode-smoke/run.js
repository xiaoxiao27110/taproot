const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const workspacePath = path.resolve(extensionDevelopmentPath, '..');
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taproot-vscode-user-'));
  const configPath = path.join(userDataDir, 'nodes.yaml');
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';

  await fs.writeFile(configPath, 'defaults:\n  user: taproot\n  port: 22\nnodes: {}\n', 'utf8');
  process.env.TAPROOT_TEST_CONFIG = configPath;

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--user-data-dir',
      userDataDir,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
