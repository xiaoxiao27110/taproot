import os
from pathlib import Path

import pytest

from taproot_mcp.config import load_config
from taproot_mcp.server import TaprootTools


pytestmark = pytest.mark.asyncio


def require_local_config() -> Path:
    value = os.environ.get("TAPROOT_TEST_CONFIG")
    if not value:
        pytest.skip("set TAPROOT_TEST_CONFIG to run localhost tmux integration tests")
    return Path(value)


@pytest.fixture
async def tools():
    tools = TaprootTools(load_config(require_local_config()))
    try:
        yield tools
    finally:
        await tools.aclose()


async def session_exec(
    tools: TaprootTools, session_id: str, command: str, timeout: int = 60
) -> dict:
    return await tools.cluster_session_exec(session_id, command, timeout)


async def test_tmux_session_preserves_state_and_exit_code(tools: TaprootTools) -> None:
    opened = await tools.cluster_session_open("local-vllm")
    assert opened["summary"] == {"success": 1, "failed": 0, "total": 1}
    session_id = opened["results"]["local-vllm"]["session_id"]

    try:
        first = await session_exec(
            tools,
            session_id, "cd /tmp && export TAPROOT_SESSION_TEST=ok"
        )
        assert first["results"]["local-vllm"]["exit_code"] == 0

        second = await session_exec(
            tools,
            session_id, "pwd; printf \"env=$TAPROOT_SESSION_TEST\""
        )
        output = second["results"]["local-vllm"]["output"]
        assert "/tmp" in output
        assert "env=ok" in output

        failed = await session_exec(tools, session_id, "sh -c 'exit 7'")
        assert failed["results"]["local-vllm"]["exit_code"] == 7
    finally:
        closed = await tools.cluster_session_close(session_id)
        assert closed["results"]["local-vllm"]["closed"] is True


async def test_tmux_session_read_interrupt_and_list(tools: TaprootTools) -> None:
    opened = await tools.cluster_session_open("local-vllm")
    session_id = opened["results"]["local-vllm"]["session_id"]

    try:
        listed = await tools.cluster_session_list()
        assert any(
            item["session_id"] == session_id
            for item in listed["results"]["sessions"]["sessions"]
        )

        long_running = await session_exec(
            tools,
            session_id, "while true; do echo tick; sleep 1; done", timeout=1
        )
        assert long_running["results"]["local-vllm"]["ok"] is False

        read = await tools.cluster_session_read(session_id, lines=20)
        assert "tick" in read["results"]["local-vllm"]["output"]

        interrupted = await tools.cluster_session_interrupt(session_id)
        assert interrupted["results"]["local-vllm"]["ok"] is True
    finally:
        await tools.cluster_session_close(session_id)
