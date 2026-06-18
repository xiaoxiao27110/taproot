import inspect

from taproot_mcp.config import ClusterConfig, NodeConfig
from taproot_mcp.models import make_envelope
from taproot_mcp.server import TaprootTools, build_mcp_server


def test_make_envelope_counts_summary() -> None:
    envelope = make_envelope(
        {
            "node-a": {"ok": True, "stdout": "ok", "stderr": "", "exit_code": 0},
            "node-b": {"ok": False, "error": "connection refused"},
        }
    )

    assert envelope["summary"] == {"success": 1, "failed": 1, "total": 2}


def test_tool_contract_has_prd_tools_and_target_docs() -> None:
    config = ClusterConfig(nodes={"local": NodeConfig(name="local", host="localhost")})
    tools = TaprootTools(config)

    expected = {
        "cluster_exec",
        "cluster_read_file",
        "cluster_edit_file",
        "cluster_write_file",
        "cluster_list_dir",
        "cluster_glob",
        "cluster_system_info",
        "cluster_service",
        "cluster_upload",
        "cluster_download",
        "cluster_session_open",
        "cluster_session_exec",
        "cluster_session_read",
        "cluster_session_interrupt",
        "cluster_session_close",
        "cluster_session_list",
    }

    actual = {
        name
        for name, member in inspect.getmembers(tools, predicate=inspect.ismethod)
        if name.startswith("cluster_")
    }

    assert expected <= actual

    for name in expected:
        doc = inspect.getdoc(getattr(tools, name)) or ""
        assert doc
        if name.startswith("cluster_session_"):
            assert "会话" in doc or "session" in doc
        else:
            assert "target" in doc
            assert "all" in doc
            assert "tag:" in doc


def test_mcp_server_builds_with_registered_tools() -> None:
    config = ClusterConfig(nodes={"local": NodeConfig(name="local", host="localhost")})
    server = build_mcp_server(TaprootTools(config))

    assert server.name == "taproot-mcp"
