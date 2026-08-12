#!/usr/bin/env python3
"""Fail-closed JiuwenSwarm PreToolUse bridge for EA governance."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request


MAX_INPUT_BYTES = 1024 * 1024
SAFE_TOOL_RE = re.compile(
    r"^(?:read_file|read_memory|memory_get|memory_search|glob|grep|list_files|list_skill|"
    r"list_skill_experiences|read_skill_experiences|search_tools|todo_get|todo_list|"
    r"audio_metadata|experience_retrieve|skill_branch_explore|skill_branch_peek|wiki_lint|wiki_query|"
    r"ask_user|audio_question_answering|generate_image|load_tools|skill_tool|task_tool|"
    r"video_understanding|visual_question_answering|bash|code|exec_command|execute_command|"
    r"edit_file|write_file|edit_memory|write_memory|todo_create|todo_modify|"
    r"evolve_review_task|evolve_skill_experiences|prepare_skill_evolution|simplify_skill_experiences|"
    r"mcp_platform_tools_get_user_channels|mcp_platform_tools_list_available_agents|"
    r"mcp_platform_tools_list_learned_preferences|mcp_platform_tools_remember_preference|"
    r"mcp_platform_tools_forget_preference|mcp_platform_tools_get_wealth_policy_basis|"
    r"mcp_platform_tools_prepare_wealth_maturity_context|"
    r"mcp_platform_tools_prepare_wealth_allocation_context)$",
    re.IGNORECASE,
)
READ_PREFIXES = ("mcp_wind_", "mcp_market_data__", "mcp_wealth_assistant_")


def emit(decision: str, reason: str = "") -> int:
    payload = {"decision": decision}
    if reason:
        payload["reason"] = reason
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    return 0


def safe_when_policy_unavailable(payload: dict) -> bool:
    tool_name = str(payload.get("tool_name") or "").strip().lower()
    return bool(SAFE_TOOL_RE.match(tool_name) or tool_name.startswith(READ_PREFIXES))


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        return emit("block", "工具参数过大，治理检查已拒绝执行。")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return emit("block", "工具治理输入无效，已拒绝执行。")
    if not isinstance(payload, dict):
        return emit("block", "工具治理输入无效，已拒绝执行。")

    base_url = os.environ.get("WORKFORCE_AGENT_INTERNAL_BASE_URL", "http://127.0.0.1:5180").rstrip("/")
    url = os.environ.get("EA_GOVERNANCE_HOOK_URL", f"{base_url}/api/internal/security/pre-tool")
    internal_key = os.environ.get("INTERNAL_API_KEY", "").strip()
    if not internal_key:
        if safe_when_policy_unavailable(payload):
            return emit("allow")
        return emit("block", "治理凭据缺失，业务副作用工具已拒绝执行。")

    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "x-internal-key": internal_key,
            "x-linggan-runtime-id": os.environ.get("JIUWENSWARM_RUNTIME_ID", "jiuwenswarm-local"),
            "x-linggan-hook-version": os.environ.get("EA_GOVERNANCE_RULE_VERSION", "ea-governance-v1"),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=2.5) as response:
            result = json.loads(response.read(64 * 1024).decode("utf-8"))
        if isinstance(result, dict) and result.get("decision") in {"allow", "block"}:
            return emit(str(result["decision"]), str(result.get("reason") or ""))
    except (OSError, ValueError, urllib.error.URLError):
        pass
    if safe_when_policy_unavailable(payload):
        return emit("allow")
    return emit("block", "治理服务暂不可用，业务副作用工具已拒绝执行。")


if __name__ == "__main__":
    raise SystemExit(main())
