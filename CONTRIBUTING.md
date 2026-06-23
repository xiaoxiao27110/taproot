# Contributing

Thanks for helping improve Taproot.

## Development Setup

Install the Python package in editable mode:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[test]"
```

Install the VS Code extension dependencies:

```bash
cd taproot-plugin
npm ci
```

## Tests

Run the Python tests:

```bash
python -m pytest
```

Run the VS Code extension tests:

```bash
cd taproot-plugin
npm test
npm audit --omit=dev
npm run package:vsix
```

Local SSH and tmux integration tests are skipped unless `TAPROOT_TEST_CONFIG` is set. See `test-flow/README.md`.

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Do not commit `nodes.yaml`, `.taproot/`, `.venv/`, `node_modules/`, `out/`, `dist/`, or VSIX files.
- Remove or redact all real hostnames, usernames, IPs, keys, passwords, and tokens from test data and logs.
