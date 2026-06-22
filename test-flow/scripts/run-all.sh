#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

python3 -m pytest \
  test-flow/tests/test_config_targeting.py \
  test-flow/tests/test_models_and_contract.py \
  test-flow/tests/test_history.py \
  test-flow/tests/test_approvals.py

if [[ -n "${TAPROOT_TEST_CONFIG:-}" ]]; then
  python3 -m pytest \
    test-flow/tests/test_local_ssh_v01.py \
    test-flow/tests/test_local_tmux_v02.py
else
  printf '%s\n' "Skipping SSH/tmux integration tests: set TAPROOT_TEST_CONFIG to enable them."
fi
