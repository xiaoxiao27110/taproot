import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from taproot_mcp.approvals import ApprovalStore
from taproot_mcp.config import ClusterConfig, NodeConfig, load_config
from taproot_mcp.server import TaprootTools


pytestmark = pytest.mark.asyncio


def require_local_config() -> Path:
    value = os.environ.get("TAPROOT_TEST_CONFIG")
    if not value:
        pytest.skip("set TAPROOT_TEST_CONFIG to run localhost SSH integration tests")
    return Path(value)


@pytest.fixture
async def tools():
    config = load_config(require_local_config())
    tools = TaprootTools(config)
    try:
        yield tools
    finally:
        await tools.aclose()


def approve_result(config: ClusterConfig, result: dict, node: str) -> None:
    assert result["results"][node]["approval_required"] is True
    pending = ApprovalStore(config).list(status="pending")
    assert pending
    ApprovalStore(config).approve(pending[0]["id"])


async def test_exec_targeting_and_stateless_cwd(tools: TaprootTools) -> None:
    result = await tools.cluster_exec("tag:vllm", "printf vllm")
    assert result["results"]["local-vllm"]["approval_required"] is True
    approve_result(tools.config, result, "local-vllm")

    result = await tools.cluster_exec("tag:vllm", "printf vllm")
    assert result["summary"] == {"success": 1, "failed": 0, "total": 1}
    assert list(result["results"]) == ["local-vllm"]
    assert result["results"]["local-vllm"]["stdout"] == "vllm"

    cd_result = await tools.cluster_exec("local-vllm", "cd /tmp")
    approve_result(tools.config, cd_result, "local-vllm")
    await tools.cluster_exec("local-vllm", "cd /tmp")

    pwd = await tools.cluster_exec("local-vllm", "pwd")
    approve_result(tools.config, pwd, "local-vllm")
    pwd = await tools.cluster_exec("local-vllm", "pwd")
    assert pwd["results"]["local-vllm"]["stdout"].strip() != "/tmp"

    cwd_pwd = await tools.cluster_exec("local-vllm", "pwd", cwd="/tmp")
    approve_result(tools.config, cwd_pwd, "local-vllm")
    cwd_pwd = await tools.cluster_exec("local-vllm", "pwd", cwd="/tmp")
    assert cwd_pwd["results"]["local-vllm"]["stdout"].strip() == "/tmp"


async def test_file_read_write_edit_list_glob(tools: TaprootTools, tmp_path: Path) -> None:
    remote_dir = f"taproot-test-{os.getpid()}"
    remote_file = f"{remote_dir}/config.yaml"

    written = await tools.cluster_write_file("local-vllm", remote_file, "port: 8080\nname: old\n")
    assert written["results"]["local-vllm"]["ok"] is True
    assert written["results"]["local-vllm"]["bytes_written"] > 0

    read = await tools.cluster_read_file("local-vllm", remote_file)
    assert read["results"]["local-vllm"]["content"] == "port: 8080\nname: old\n"

    edited = await tools.cluster_edit_file(
        "local-vllm", remote_file, "port: 8080", "port: 8081"
    )
    assert edited["results"]["local-vllm"]["changed"] is True
    assert edited["results"]["local-vllm"]["backup_path"]
    assert "/.taproot/backups/" in edited["results"]["local-vllm"]["backup_path"]

    listed = await tools.cluster_list_dir("local-vllm", remote_dir)
    assert any(entry["name"] == "config.yaml" for entry in listed["results"]["local-vllm"]["entries"])

    globbed = await tools.cluster_glob("local-vllm", "*.yaml", remote_dir)
    assert any(match["path"].endswith(f"/{remote_file}") for match in globbed["results"]["local-vllm"]["matches"])


async def test_upload_download_idempotent(tools: TaprootTools, tmp_path: Path) -> None:
    local_file = tmp_path / "install.sh"
    local_file.write_text("#!/usr/bin/env sh\necho taproot\n", encoding="utf-8")
    remote_path = f"taproot-upload-{os.getpid()}.sh"

    uploaded = await tools.cluster_upload("local-*", str(local_file), remote_path, mode="755")
    assert uploaded["summary"]["failed"] == 0
    assert uploaded["summary"]["total"] == 2

    uploaded_again = await tools.cluster_upload("local-*", str(local_file), remote_path, mode="755")
    assert all(item["skipped"] for item in uploaded_again["results"].values())

    download_dir = tmp_path / "downloads"
    downloaded = await tools.cluster_download("local-*", remote_path, str(download_dir))
    assert downloaded["summary"]["failed"] == 0
    for node in ("local-vllm", "local-build"):
        downloaded_path = Path(downloaded["results"][node]["local_path"])
        assert downloaded_path.exists()
        assert hashlib.sha256(downloaded_path.read_bytes()).hexdigest() == hashlib.sha256(
            local_file.read_bytes()
        ).hexdigest()

    local_dir = tmp_path / "bundle"
    local_dir.mkdir()
    (local_dir / "a.txt").write_text("alpha", encoding="utf-8")
    (local_dir / "b.txt").write_text("beta", encoding="utf-8")
    remote_dir = f"taproot-upload-dir-{os.getpid()}"

    uploaded_dir = await tools.cluster_upload("local-vllm", str(local_dir), remote_dir)
    assert uploaded_dir["results"]["local-vllm"]["ok"] is True
    assert uploaded_dir["results"]["local-vllm"]["files"] == 2

    uploaded_dir_again = await tools.cluster_upload("local-vllm", str(local_dir), remote_dir)
    assert uploaded_dir_again["results"]["local-vllm"]["skipped"] is True


async def test_home_policy_blocks_sensitive_paths_and_prompts_outside_home(
    tools: TaprootTools,
) -> None:
    denied = await tools.cluster_write_file("local-vllm", ".ssh/authorized_keys", "bad")
    assert denied["results"]["local-vllm"]["ok"] is False
    assert "protected home path" in denied["results"]["local-vllm"]["error"]

    outside = await tools.cluster_read_file("local-vllm", "/etc/passwd")
    assert outside["results"]["local-vllm"]["approval_required"] is True


async def test_backup_retention_prunes_by_count_and_age(tools: TaprootTools) -> None:
    node = "local-vllm"
    home = await tools._remote_home(node)  # type: ignore[attr-defined]
    backup_dir = f"{home}/.taproot/backups/retention-test-{os.getpid()}"
    now = datetime.now(timezone.utc)
    names = [
        f"{(now - timedelta(seconds=index)).strftime('%Y%m%dT%H%M%S.%fZ')}--file.txt"
        for index in range(302)
    ]
    old_name = f"{(now - timedelta(days=31)).strftime('%Y%m%dT%H%M%S.%fZ')}--file.txt"
    names.append(old_name)
    payload = json.dumps(names)
    create_script = f"""
import json
import os
import sys

backup_dir = sys.argv[1]
names = json.loads(sys.argv[2])
os.makedirs(backup_dir, exist_ok=True)
for name in names:
    with open(os.path.join(backup_dir, name), "w", encoding="utf-8") as handle:
        handle.write(name)
"""
    await tools.pool.run(
        node,
        f"python3 - {backup_dir!r} {payload!r} <<'PY'\n{create_script.strip()}\nPY",
        timeout=30,
    )

    try:
        await tools._prune_backups(node, backup_dir)  # type: ignore[attr-defined]
        list_script = """
import os
import sys

backup_dir = sys.argv[1]
print("\\n".join(sorted(os.listdir(backup_dir))))
"""
        listed = await tools.pool.run(
            node,
            f"python3 - {backup_dir!r} <<'PY'\n{list_script.strip()}\nPY",
            timeout=30,
        )
        remaining = [line for line in listed.stdout.splitlines() if line]
        assert len(remaining) == 300
        assert old_name not in remaining
        assert names[0] in remaining
        assert names[301] not in remaining
    finally:
        await tools.pool.run(node, f"rm -rf {backup_dir!r}", timeout=30)


async def test_system_info_and_unreachable_node_failure_are_enveloped(tmp_path: Path) -> None:
    base_config = load_config(require_local_config())
    good_name = next(iter(base_config.nodes))
    config = ClusterConfig(
        nodes={
            good_name: base_config.nodes[good_name],
            "bad-node": NodeConfig(name="bad-node", host="127.0.0.1", port=1, tags=["bad"]),
        }
    )
    tools = TaprootTools(config)
    try:
        info = await tools.cluster_system_info("all")
    finally:
        await tools.aclose()

    assert info["summary"]["total"] == 2
    assert info["results"][good_name]["ok"] is True
    assert info["results"]["bad-node"]["ok"] is False
    assert "error" in info["results"]["bad-node"]
