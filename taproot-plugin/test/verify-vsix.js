const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsixPath = path.resolve(root, process.argv[2] || `${manifest.name}-${manifest.version}.vsix`);

function unzip(args) {
  return execFileSync('unzip', args, { encoding: 'utf8' });
}

function readArchiveJson(entry) {
  return JSON.parse(unzip(['-p', vsixPath, entry]));
}

assert(fs.existsSync(vsixPath), `VSIX not found: ${vsixPath}`);

const entries = new Set(unzip(['-Z1', vsixPath]).trim().split(/\r?\n/).filter(Boolean));
const requiredEntries = [
  'extension/package.json',
  'extension/out/src/extension.js',
  'extension/out/src/configModel.js',
  'extension/media/taproot-icons.woff',
  'extension/media/taproot-status.svg',
  'extension/node_modules/js-yaml/package.json',
  'extension/node_modules/argparse/package.json',
  'extension/node_modules/@vscode/codicons/dist/codicon.css',
  'extension/node_modules/@vscode/codicons/dist/codicon.ttf',
];

for (const entry of requiredEntries) {
  assert(entries.has(entry), `VSIX is missing required runtime file: ${entry}`);
}

const packagedManifest = readArchiveJson('extension/package.json');
const commands = packagedManifest.contributes?.commands?.map((command) => command.command) || [];
assert.equal(packagedManifest.main, './out/src/extension.js');
assert(packagedManifest.activationEvents.includes('onView:taproot.nodes'));
assert(packagedManifest.activationEvents.includes('onCommand:taproot.refreshNodes'));
assert.equal(packagedManifest.contributes?.icons?.['taproot-root']?.default?.fontPath, './media/taproot-icons.woff');
assert(commands.includes('taproot.refreshNodes'));

const extensionSource = unzip(['-p', vsixPath, 'extension/out/src/extension.js']);
assert(extensionSource.includes("registerCommand('taproot.refreshNodes'"));
assert(extensionSource.includes("status.text = '$(taproot-root) Taproot';"));

console.log(`Verified ${path.basename(vsixPath)} contains runtime dependencies and Taproot commands.`);
