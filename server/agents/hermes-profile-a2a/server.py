#!/usr/bin/env python3
"""Expose one Hermes expert profile through a small authenticated A2A endpoint."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import signal
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


ROOT = Path(__file__).resolve().parent
MERGE_TOOL = ROOT / "merge_verified_pages_linux.py"
LOGGER = logging.getLogger("hermes_profile_a2a")


class ConfigurationError(RuntimeError):
    pass


def load_env(
    path: Path,
    *,
    override: bool = False,
    allowed_keys: set[str] | None = None,
) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"").strip("'")
        if allowed_keys is not None and key not in allowed_keys:
            continue
        if key and (override or key not in os.environ):
            os.environ[key] = value


load_env(ROOT / ".env")

HOST = os.environ.get("A2A_HOST", "127.0.0.1")
PORT = int(os.environ.get("A2A_PORT", "8898"))
PROFILE = os.environ.get("HERMES_PROFILE", "ppt-expert").strip()
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
if not PROFILE_RE.fullmatch(PROFILE):
    raise ConfigurationError("HERMES_PROFILE is invalid")
PROFILE_CREDENTIALS_FILE = Path(
    os.environ.get(
        "A2A_PROFILE_CREDENTIALS_FILE",
        f"/home/ubuntu/.hermes/profiles/{PROFILE}/a2a-credentials.env",
    )
).expanduser()
load_env(
    PROFILE_CREDENTIALS_FILE,
    override=True,
    allowed_keys={"A2A_BEARER_TOKEN", "A2A_DOWNLOAD_SECRET"},
)
HERMES_BIN = os.environ.get("HERMES_BIN", "/home/ubuntu/.local/bin/hermes")
SHARED_WORKSPACE = Path(
    os.environ.get(
        "HERMES_PROFILE_WORKSPACE",
        f"/home/ubuntu/.hermes/profiles/{PROFILE}/workspace",
    )
).resolve()
WORKSPACES_ROOT = Path(
    os.environ.get(
        "A2A_WORKSPACES_ROOT",
        f"/home/ubuntu/.hermes/profiles/{PROFILE}/a2a-workspaces",
    )
).resolve()
STATE_FILE = Path(
    os.environ.get(
        "A2A_STATE_FILE",
        f"/home/ubuntu/.hermes/profiles/{PROFILE}/a2a-state.json",
    )
).resolve()
PROFILE_STATE_DB = Path(
    os.environ.get(
        "HERMES_PROFILE_STATE_DB",
        f"/home/ubuntu/.hermes/profiles/{PROFILE}/state.db",
    )
).resolve()
PUBLIC_BASE_URL = os.environ.get(
    "A2A_PUBLIC_BASE_URL",
    "https://work.linggan.top/a2a/ppt-expert",
).rstrip("/")
BEARER_TOKEN = os.environ.get("A2A_BEARER_TOKEN", "")
DOWNLOAD_SECRET = os.environ.get("A2A_DOWNLOAD_SECRET", "")
TASK_TIMEOUT_SECONDS = max(30, min(1_500, int(os.environ.get("A2A_TASK_TIMEOUT_SECONDS", "1350"))))
HERMES_MAX_TURNS = max(20, min(160, int(os.environ.get("HERMES_MAX_TURNS", "100"))))
# PPT-specific toolchain checks (LibreOffice, PptxGenJS, OOXML merger). Defaults
# on for backward compatibility with the ppt-expert profile; other profiles
# (e.g. diagram-expert) set A2A_REQUIRE_PPT_TOOLS=0 to skip them.
REQUIRE_PPT_TOOLS = os.environ.get("A2A_REQUIRE_PPT_TOOLS", "1").strip() not in ("0", "false", "no", "")
WORKSPACE_KIND = os.environ.get(
    "A2A_WORKSPACE_KIND",
    "ppt" if REQUIRE_PPT_TOOLS else "diagram",
).strip().lower()
REQUIRE_ARTIFACTS = os.environ.get("A2A_REQUIRE_ARTIFACTS", "0").strip() not in ("0", "false", "no", "")
# Optional external task-prompt preamble (per profile). Falls back to the
# built-in PPT prompt when unset.
PROMPT_FILE = os.environ.get("A2A_PROMPT_FILE", "").strip()
# Agent card metadata (defaults describe the ppt-expert profile).
AGENT_NAME = os.environ.get("A2A_AGENT_NAME", "PPT 专家")
AGENT_DESCRIPTION = os.environ.get(
    "A2A_AGENT_DESCRIPTION",
    "由独立 Hermes Profile 驱动，使用 CyberPPT 完成证据分析、视觉蓝图、可编辑 PPTX 和质量检查。",
)
# Skill(s) passed to `hermes chat --skills`. Defaults to cyber-ppt (ppt-expert).
HERMES_SKILLS = os.environ.get("A2A_HERMES_SKILLS", "cyber-ppt").strip()
AGENT_SKILL_ID = os.environ.get("A2A_SKILL_ID", "cyber-ppt")
AGENT_SKILL_NAME = os.environ.get("A2A_SKILL_NAME", "CyberPPT")
AGENT_SKILL_DESCRIPTION = os.environ.get(
    "A2A_SKILL_DESCRIPTION", "生成高密度、可编辑、咨询风格 PowerPoint。"
)
AGENT_SKILL_TAGS = [
    t.strip()
    for t in os.environ.get("A2A_SKILL_TAGS", "pptx,presentation,consulting,a2a").split(",")
    if t.strip()
]
MAX_BODY_BYTES = 1024 * 1024
MAX_RESPONSE_CHARS = 120_000
DOWNLOAD_TTL_SECONDS = 60 * 60
STATE_VERSION = 2
MAX_CONTEXTS = max(8, min(4096, int(os.environ.get("A2A_MAX_CONTEXTS", "256"))))
CONTEXT_TTL_SECONDS = max(
    60 * 60,
    min(365 * 24 * 60 * 60, int(os.environ.get("A2A_CONTEXT_TTL_SECONDS", str(30 * 24 * 60 * 60)))),
)
CLEANUP_INTERVAL_SECONDS = max(
    5 * 60,
    min(24 * 60 * 60, int(os.environ.get("A2A_CLEANUP_INTERVAL_SECONDS", "3600"))),
)
MAX_CONCURRENT_TASKS = max(1, min(8, int(os.environ.get("A2A_MAX_CONCURRENT_TASKS", "2"))))
ALLOWED_TOOLSETS = {"terminal", "file", "vision", "web"}


def normalized_toolsets(value: str) -> str:
    toolsets: list[str] = []
    for part in value.split(","):
        item = part.strip()
        if item and item not in toolsets:
            toolsets.append(item)
    return ",".join(toolsets)


HERMES_TOOLSETS = normalized_toolsets(
    os.environ.get("HERMES_TOOLSETS", "terminal,file,vision")
)
ALLOWED_ARTIFACT_SUFFIXES = {
    ".pptx",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".md",
    ".json",
    ".txt",
    ".xlsx",
    ".docx",
}
PRESENTABLE_ARTIFACT_SUFFIXES = {
    ".pptx",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".docx",
    ".xlsx",
    ".csv",
    ".md",
    ".txt",
}
INTERNAL_ARTIFACT_DIRS = {
    "production",
    "locks",
    "blueprints",
    "manifests",
    "qa",
    "pages",
    "renders",
    "merge_qa",
    "final-linux-qa",
    "evidence",
}
# Per-profile extra deliverable suffixes (e.g. diagram-expert adds .html,.svg).
# Keeps ppt-expert behavior unchanged when unset.
_EXTRA_ARTIFACT_SUFFIXES = {
    ("." + s.strip().lstrip(".").lower())
    for s in os.environ.get("A2A_EXTRA_ARTIFACT_SUFFIXES", "").split(",")
    if s.strip()
}
ALLOWED_ARTIFACT_SUFFIXES |= _EXTRA_ARTIFACT_SUFFIXES
PRESENTABLE_ARTIFACT_SUFFIXES |= _EXTRA_ARTIFACT_SUFFIXES
SESSION_ID_RE = re.compile(r"(?:session_id|Session ID):\s*([^\s]+)", re.IGNORECASE)
RESET_RE = re.compile(
    os.environ.get(
        "A2A_RESET_PATTERN",
        r"^\s*(?:/new|重新开始|新建任务|新建(?:一份|一个)?\s*PPT|开始新PPT)",
    ),
    re.IGNORECASE,
)
CONNECTION_TEST_RE = re.compile(r"^\s*连接测试[：:]", re.IGNORECASE)
INTERACTION_RE = re.compile(r"<ea_interaction>\s*(\{[\s\S]*?\})\s*</ea_interaction>", re.IGNORECASE)
SAFE_INTERACTION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SECRET_RE = re.compile(
    r"(?i)(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+"
)
SENSITIVE_ENV_KEY_RE = re.compile(
    r"(?i)(?:^|_)(?:api_?key|token|secret|password|passwd|private_?key|credentials?)(?:_|$)"
)
SENSITIVE_ENV_KEYS = {
    "DATABASE_URL",
    "REDIS_URL",
    "SMTP_URL",
}
STATE_LOCK = threading.Lock()
LOCKS_LOCK = threading.Lock()
ACTIVE_LOCK = threading.Lock()
PROCESS_LOCK = threading.Lock()
RUN_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_TASKS)
CONTEXT_LOCKS: dict[str, threading.Lock] = {}
ACTIVE_PROCESSES: dict[str, subprocess.Popen] = {}
CANCELLED_PIDS: set[int] = set()
ACTIVE_TASKS = 0
CLEANUP_STOP = threading.Event()


class HermesRunError(RuntimeError):
    pass


def require_secure_config() -> None:
    if len(BEARER_TOKEN) < 32:
        raise ConfigurationError("A2A_BEARER_TOKEN must contain at least 32 characters")
    if len(DOWNLOAD_SECRET) < 32:
        raise ConfigurationError("A2A_DOWNLOAD_SECRET must contain at least 32 characters")
    if not PROFILE_RE.fullmatch(PROFILE):
        raise ConfigurationError("HERMES_PROFILE is invalid")
    if not Path(HERMES_BIN).is_file():
        raise ConfigurationError(f"Hermes executable not found: {HERMES_BIN}")
    configured_toolsets = set(HERMES_TOOLSETS.split(","))
    if not configured_toolsets or not configured_toolsets.issubset(ALLOWED_TOOLSETS):
        raise ConfigurationError("HERMES_TOOLSETS may only contain terminal,file,vision,web")
    if WORKSPACE_KIND not in {"generic", "ppt", "diagram"}:
        raise ConfigurationError("A2A_WORKSPACE_KIND must be generic, ppt, or diagram")
    if WORKSPACE_KIND in {"ppt", "diagram"} and not {"terminal", "file"}.issubset(configured_toolsets):
        raise ConfigurationError(f"{WORKSPACE_KIND} experts require terminal and file toolsets")
    SHARED_WORKSPACE.mkdir(parents=True, exist_ok=True)
    WORKSPACES_ROOT.mkdir(parents=True, exist_ok=True)
    if WORKSPACE_KIND in {"ppt", "diagram"} and not shutil.which("node"):
        raise ConfigurationError(f"Node.js is required by the {WORKSPACE_KIND} expert")
    if WORKSPACE_KIND == "ppt":
        if not shutil.which("libreoffice"):
            raise ConfigurationError("LibreOffice is required by the PPT expert")
        if not (SHARED_WORKSPACE / "node_modules" / "pptxgenjs").is_dir():
            raise ConfigurationError("PptxGenJS is missing from the shared PPT workspace")
        if not MERGE_TOOL.is_file():
            raise ConfigurationError(f"Linux PPTX merge tool is missing: {MERGE_TOOL}")


def is_sensitive_env_key(key: str) -> bool:
    return key.upper() in SENSITIVE_ENV_KEYS or bool(SENSITIVE_ENV_KEY_RE.search(key))


def sensitive_env_values(env: dict[str, str] | None = None) -> set[str]:
    source = env if env is not None else os.environ
    return {
        str(value)
        for key, value in source.items()
        if is_sensitive_env_key(key) and len(str(value)) >= 8
    }


def subprocess_environment() -> dict[str, str]:
    process_env = {
        key: value
        for key, value in os.environ.items()
        if not is_sensitive_env_key(key)
    }
    # PM2 gives non-Node apps an IPC descriptor. A later Node child treats the
    # inherited descriptor as its own channel and aborts after successful work.
    for key in ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"):
        process_env.pop(key, None)
    return process_env


def redact_error(value: str) -> str:
    text = value or ""
    for secret in sorted(sensitive_env_values(), key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = SECRET_RE.sub("[REDACTED]", text)
    text = text.replace(str(Path.home()), "~")
    return text[-2_000:]


def _load_state_unlocked() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict) or data.get("version") != STATE_VERSION:
        return {"version": STATE_VERSION, "sessions": {}}
    if not isinstance(data.get("sessions"), dict):
        data["sessions"] = {}
    return data


def _write_state_unlocked(data: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(temp, 0o600)
    temp.replace(STATE_FILE)


def _pruned_sessions(raw: dict) -> dict:
    cutoff = int(time.time()) - CONTEXT_TTL_SECONDS
    rows = []
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        session_id = str(value.get("sessionId") or "").strip()
        updated_at = int(value.get("updatedAt") or 0)
        if session_id and updated_at >= cutoff:
            rows.append((updated_at, key, {"sessionId": session_id, "updatedAt": updated_at}))
    rows.sort(reverse=True)
    return {key: value for _, key, value in rows[:MAX_CONTEXTS]}


def workspace_path_for_context(key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    workspace = (WORKSPACES_ROOT / f"ctx-{digest}").resolve()
    workspace.relative_to(WORKSPACES_ROOT)
    return workspace


def _touch_workspace(workspace: Path, key: str) -> None:
    marker = workspace / ".ea-context.json"
    payload = {"contextId": key, "updatedAt": int(time.time())}
    temp = marker.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temp.replace(marker)


def _workspace_updated_at(workspace: Path) -> int:
    marker = workspace / ".ea-context.json"
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
        return int(payload.get("updatedAt") or 0)
    except (OSError, TypeError, ValueError):
        try:
            return int(workspace.stat().st_mtime)
        except OSError:
            return 0


def active_context_keys() -> set[str]:
    with PROCESS_LOCK:
        active = {key.removeprefix("context:") for key in ACTIVE_PROCESSES if key.startswith("context:")}
    with LOCKS_LOCK:
        active.update(key for key, lock in CONTEXT_LOCKS.items() if lock.locked())
    return active


def cleanup_stale_contexts(now: int | None = None) -> int:
    current = int(now or time.time())
    cutoff = current - CONTEXT_TTL_SECONDS
    active = active_context_keys()
    candidates: list[tuple[int, Path, str]] = []
    if not WORKSPACES_ROOT.is_dir():
        return 0
    for workspace in WORKSPACES_ROOT.iterdir():
        if not workspace.is_dir() or not workspace.name.startswith("ctx-"):
            continue
        marker = workspace / ".ea-context.json"
        context_id = ""
        try:
            context_id = str(json.loads(marker.read_text(encoding="utf-8")).get("contextId") or "")
        except (OSError, TypeError, ValueError):
            pass
        candidates.append((_workspace_updated_at(workspace), workspace, context_id))

    candidates.sort(key=lambda row: row[0], reverse=True)
    removed = 0
    for index, (updated_at, workspace, context_id) in enumerate(candidates):
        if context_id in active:
            continue
        if updated_at >= cutoff and index < MAX_CONTEXTS:
            continue
        shutil.rmtree(workspace, ignore_errors=True)
        if not workspace.exists():
            removed += 1

    with STATE_LOCK:
        state = _load_state_unlocked()
        sessions = _pruned_sessions(state.get("sessions", {}))
        state.update({"version": STATE_VERSION, "sessions": sessions, "updatedAt": current})
        _write_state_unlocked(state)
    return removed


def cleanup_loop() -> None:
    while not CLEANUP_STOP.wait(CLEANUP_INTERVAL_SECONDS):
        try:
            removed = cleanup_stale_contexts()
            if removed:
                LOGGER.info("Hermes A2A cleanup removed %s stale workspaces", removed)
        except Exception as error:
            LOGGER.error("Hermes A2A cleanup failed: %s", redact_error(str(error)))


def read_session(key: str) -> str | None:
    if key == "default":
        return None
    with STATE_LOCK:
        state = _load_state_unlocked()
        sessions = _pruned_sessions(state.get("sessions", {}))
        entry = sessions.get(key)
        return str(entry.get("sessionId")) if isinstance(entry, dict) else None


def remember_session(key: str, session_id: str) -> None:
    if key == "default" or not session_id:
        return
    with STATE_LOCK:
        state = _load_state_unlocked()
        sessions = _pruned_sessions(state.get("sessions", {}))
        sessions[key] = {"sessionId": session_id, "updatedAt": int(time.time())}
        state.update({"version": STATE_VERSION, "sessions": _pruned_sessions(sessions), "updatedAt": int(time.time())})
        _write_state_unlocked(state)


def forget_session(key: str) -> None:
    if key == "default":
        return
    with STATE_LOCK:
        state = _load_state_unlocked()
        sessions = _pruned_sessions(state.get("sessions", {}))
        sessions.pop(key, None)
        state.update({"version": STATE_VERSION, "sessions": sessions, "updatedAt": int(time.time())})
        _write_state_unlocked(state)


def workspace_for_context(key: str) -> Path:
    workspace = workspace_path_for_context(key)
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "projects").mkdir(exist_ok=True)
    palette_source = SHARED_WORKSPACE / "reference" / "palettes"
    if WORKSPACE_KIND == "ppt":
        palette_parent = workspace / "reference"
        palette_link = palette_parent / "palettes"
        if palette_source.is_dir() and not palette_link.exists():
            palette_parent.mkdir(exist_ok=True)
            palette_link.symlink_to(palette_source, target_is_directory=True)
        package_source = SHARED_WORKSPACE / "package.json"
        package_target = workspace / "package.json"
        if package_source.is_file() and not package_target.exists():
            shutil.copy2(package_source, package_target)
        node_modules_source = SHARED_WORKSPACE / "node_modules"
        node_modules_link = workspace / "node_modules"
        if node_modules_source.is_dir() and not node_modules_link.exists():
            node_modules_link.symlink_to(node_modules_source, target_is_directory=True)
        tools_directory = workspace / "tools"
        tools_directory.mkdir(exist_ok=True)
        workspace_merge_tool = tools_directory / MERGE_TOOL.name
        shutil.copy2(MERGE_TOOL, workspace_merge_tool)
        workspace_merge_tool.chmod(0o755)
    agents_file = workspace / "AGENTS.md"
    if WORKSPACE_KIND == "ppt":
        agents_lines = [
            "# EA PPT Expert Workspace",
            "",
            "This directory belongs to one isolated EA conversation context.",
            "Create every task artifact under this directory and never inspect sibling workspaces.",
            f"Canonical CyberPPT package: {SHARED_WORKSPACE.parent / 'vendor' / 'cyber-ppt'}",
            f"Shared CyberPPT palettes: {palette_source}",
            "Node.js, PptxGenJS, LibreOffice, terminal, file, and vision tools are available.",
            "On Linux, final deck assembly must use tools/merge_verified_pages_linux.py.",
            "Do not call the Windows COM merger and do not create an ad-hoc OOXML merge script.",
            (
                "The Linux merger imports slide dependencies and performs render regression QA; "
                "only exit code 0 is a valid final merge."
            ),
            "Use relative paths when reporting generated files.",
            "",
        ]
    elif WORKSPACE_KIND == "diagram":
        archify_root = SHARED_WORKSPACE.parent / "vendor" / "archify"
        extractor = SHARED_WORKSPACE.parent / "skills" / "archify" / "extract-svg.mjs"
        agents_lines = [
            "# EA Diagram Expert Workspace",
            "",
            "This directory belongs to one isolated EA conversation context.",
            "Create every task artifact under this directory and never inspect sibling workspaces.",
            "Keep the terminal and file-tool working directory here; never switch to the shared profile root.",
            f"Canonical Archify CLI: {archify_root / 'bin' / 'archify.mjs'}",
            f"Standalone SVG extractor: {extractor}",
            "Use those absolute tool paths, but keep all inputs and outputs under projects/<slug>/ in this workspace.",
            "A task is not complete until both HTML and SVG exist in this workspace and validation has passed.",
            "Use relative paths when reporting generated files.",
            "",
        ]
    else:
        agents_lines = [
            f"# EA {AGENT_NAME} Workspace",
            "",
            "This directory belongs to one isolated EA conversation context.",
            "Create every task artifact under this directory and never inspect sibling workspaces.",
            "Use relative paths when reporting generated files.",
            "",
        ]
    agents_content = "\n".join(agents_lines)
    if not agents_file.is_file() or agents_file.read_text(encoding="utf-8") != agents_content:
        agents_file.write_text(agents_content, encoding="utf-8")
    _touch_workspace(workspace, key)
    return workspace


def existing_workspace_for_context(key: str) -> Path | None:
    workspace = workspace_path_for_context(key)
    return workspace if workspace.is_dir() else None


def acquire_task_slot(key: str) -> threading.Lock | None:
    global ACTIVE_TASKS
    if not RUN_SEMAPHORE.acquire(blocking=False):
        return None
    with LOCKS_LOCK:
        lock = CONTEXT_LOCKS.setdefault(key, threading.Lock())
    if not lock.acquire(blocking=False):
        RUN_SEMAPHORE.release()
        return None
    with ACTIVE_LOCK:
        ACTIVE_TASKS += 1
    return lock


def release_task_slot(lock: threading.Lock) -> None:
    global ACTIVE_TASKS
    with ACTIVE_LOCK:
        ACTIVE_TASKS = max(0, ACTIVE_TASKS - 1)
    lock.release()
    RUN_SEMAPHORE.release()


def active_task_count() -> int:
    with ACTIVE_LOCK:
        return ACTIVE_TASKS


def context_key(payload: dict) -> str:
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    message = params.get("message") if isinstance(params.get("message"), dict) else {}
    raw = params.get("contextId") or message.get("contextId") or payload.get("contextId") or "default"
    value = re.sub(r"[^A-Za-z0-9_.:-]", "", str(raw))[:128]
    return value or "default"


def task_key(payload: dict) -> str:
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    message = params.get("message") if isinstance(params.get("message"), dict) else {}
    raw = message.get("taskId") or params.get("id") or payload.get("id") or ""
    return re.sub(r"[^A-Za-z0-9_.:-]", "", str(raw))[:128]


def _terminate_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    with PROCESS_LOCK:
        CANCELLED_PIDS.add(process.pid)
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def cancel_active_process(task_id: str, context_id: str) -> bool:
    with PROCESS_LOCK:
        process = ACTIVE_PROCESSES.get(f"task:{task_id}") if task_id else None
        if process is None and context_id:
            process = ACTIVE_PROCESSES.get(f"context:{context_id}")
    if process is None or process.poll() is not None:
        return False
    _terminate_process(process)
    return True


def extract_text(payload: dict) -> str:
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    message = params.get("message")
    candidates = []
    if isinstance(message, str):
        candidates.append(message)
    if isinstance(params.get("text"), str):
        candidates.append(params["text"])
    parts = message.get("parts") if isinstance(message, dict) else params.get("parts")
    if isinstance(parts, list):
        for part in parts:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                candidates.append(part["text"])
    return "\n".join(item.strip() for item in candidates if item.strip()).strip()


def build_prompt(user_text: str) -> str:
    if PROMPT_FILE:
        try:
            preamble = Path(PROMPT_FILE).read_text(encoding="utf-8").strip()
        except OSError:
            preamble = ""
        if preamble:
            return "\n".join([preamble, "", "用户请求：", user_text])
    if WORKSPACE_KIND != "ppt":
        return "\n".join(
            [
                f"[EA A2A {AGENT_NAME}任务]",
                "所有新文件只能写入当前工作目录；回复中不要暴露绝对系统路径。",
                "只有工具实际成功后才能声称任务或文件已经完成。",
                "若生成文件，最终回答只说明交付物，不列出系统路径或下载链接；A2A 网关会返回结构化产物。",
                "",
                "用户请求：",
                user_text,
            ]
        )
    return "\n".join(
        [
            "[EA A2A PPT 专家任务]",
            "必须使用 cyber-ppt skill，并遵循其中的分析、蓝图、还原确认门。",
            (
                "默认使用 EA batch_review：只保留大纲和完整视觉蓝图两次确认；第二次确认后在本轮连续完成"
                "全部页面，不得逐页请求用户确认。只有用户明确要求逐页验收时才切换 strict page-by-page。"
            ),
            (
                "整套生成仍须对每页执行内容锁定、可编辑 PPTX、渲染和 QA；同一页最多自修复两次，"
                "仍失败就明确停止在该页，禁止无界重试。"
            ),
            (
                "在 EA batch_review 中不要运行 canonical validate_pptx.py --strict，也不要补造逐页用户确认字段；"
                "该校验器仅用于 strict page-by-page。批量模式使用实际渲染、视觉检查、紧凑批量 QA 记录和"
                "最终合并回归作为交付门。"
            ),
            "所有新文件只能写入当前工作目录；回复中不要暴露绝对系统路径。",
            (
                "当前环境已提供 terminal、file、vision、Node.js、PptxGenJS 和 LibreOffice。进入制作阶段必须"
                "实际调用工具；在执行探测命令失败前，不得声称没有文件生成或渲染能力。"
            ),
            (
                "最终合并必须调用当前工作区的 tools/merge_verified_pages_linux.py；不得调用依赖 Windows COM "
                "的 merge_verified_pages.py，也不得临时编写 OOXML 合并脚本。"
            ),
            (
                "调用格式：python3 tools/merge_verified_pages_linux.py --pages <按顺序列出已确认的单页PPTX> "
                "--out <最终PPTX> --pdf-out <最终PDF> --manifest-out <合并manifest.json> --qa-dir <QA目录>。"
                "只有退出码为0且 merge_regression_pass=true 才能交付。"
            ),
            "如果当前阶段需要用户确认，请先用一两句话说明进展，再在回复末尾输出一个结构化确认块并停止。",
            "确认块必须严格使用 <ea_interaction>{JSON}</ea_interaction>，不要使用 Markdown 代码围栏。",
            (
                "JSON 格式：{\"schema\":\"ea.interaction.v1\",\"interactionId\":\"本轮唯一英文ID\","
                "\"type\":\"single_choice\",\"title\":\"确认问题\",\"options\":[{\"id\":\"option-id\","
                "\"label\":\"选项\",\"description\":\"可选说明\",\"recommended\":true}],"
                "\"allowCustom\":true,\"allowNote\":true,\"submitMode\":\"confirm\"}"
            ),
            "选项最多 8 个；可立即执行的简单选择才使用 submitMode=immediate，其余使用 confirm。",
            (
                "若生成文件，最终回答只说明交付物和 QA 结论，不要列出文件路径或下载链接；"
                "A2A 网关会自动识别并返回结构化产物。"
            ),
            "",
            "用户请求：",
            user_text,
        ]
    )


def extract_interaction(answer: str) -> tuple[str, dict | None]:
    matches = list(INTERACTION_RE.finditer(answer or ""))
    visible = INTERACTION_RE.sub("", answer or "").strip()
    if not matches:
        return visible, None
    try:
        raw = json.loads(matches[-1].group(1))
    except (TypeError, ValueError):
        return visible, None
    if not isinstance(raw, dict) or raw.get("schema") != "ea.interaction.v1" or raw.get("type") != "single_choice":
        return visible, None
    title = str(raw.get("title") or "").strip()[:240]
    raw_options = raw.get("options")
    if not title or not isinstance(raw_options, list) or not raw_options:
        return visible, None
    interaction_id = str(raw.get("interactionId") or "").strip()[:128]
    if not SAFE_INTERACTION_ID_RE.fullmatch(interaction_id):
        interaction_id = f"interaction-{uuid.uuid4().hex[:16]}"
    options = []
    used_ids = set()
    for index, item in enumerate(raw_options[:8]):
        if not isinstance(item, dict):
            return visible, None
        label = str(item.get("label") or "").strip()[:160]
        if not label:
            return visible, None
        option_id = str(item.get("id") or "").strip()[:128]
        if not SAFE_INTERACTION_ID_RE.fullmatch(option_id) or option_id in used_ids:
            option_id = f"option-{index + 1}"
        used_ids.add(option_id)
        description = str(item.get("description") or "").strip()[:360]
        option = {"id": option_id, "label": label}
        if description:
            option["description"] = description
        if item.get("recommended") is True:
            option["recommended"] = True
        options.append(option)
    description = str(raw.get("description") or "").strip()[:600]
    interaction = {
        "schema": "ea.interaction.v1",
        "interactionId": interaction_id,
        "type": "single_choice",
        "title": title,
        "options": options,
        "allowCustom": raw.get("allowCustom") is True,
        "allowNote": raw.get("allowNote") is True,
        "submitMode": "immediate" if raw.get("submitMode") == "immediate" else "confirm",
    }
    if description:
        interaction["description"] = description
    return visible, interaction


def run_process(
    args: list[str],
    workspace: Path,
    task_id: str,
    context_id: str,
) -> tuple[str, str, int]:
    process_env = subprocess_environment()
    shared_node_modules = SHARED_WORKSPACE / "node_modules"
    if shared_node_modules.is_dir():
        existing_node_path = process_env.get("NODE_PATH", "")
        process_env["NODE_PATH"] = os.pathsep.join(
            item for item in [str(shared_node_modules), existing_node_path] if item
        )
    process_env["EA_CONTEXT_WORKSPACE"] = str(workspace)
    process = subprocess.Popen(
        args,
        cwd=str(workspace),
        env=process_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    process_keys = [f"context:{context_id}"]
    if task_id:
        process_keys.append(f"task:{task_id}")
    with PROCESS_LOCK:
        for key in process_keys:
            ACTIVE_PROCESSES[key] = process
    try:
        try:
            stdout, stderr = process.communicate(timeout=TASK_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as error:
            _terminate_process(process)
            stdout, stderr = process.communicate()
            raise HermesRunError(
                f"{AGENT_NAME}本轮超过 {TASK_TIMEOUT_SECONDS} 秒，已安全停止。请缩小单轮范围后继续。"
            ) from error
        with PROCESS_LOCK:
            was_cancelled = process.pid in CANCELLED_PIDS
            CANCELLED_PIDS.discard(process.pid)
        if was_cancelled:
            raise HermesRunError(f"{AGENT_NAME}任务已取消")
        return stdout, stderr, process.returncode
    finally:
        with PROCESS_LOCK:
            for key in process_keys:
                if ACTIVE_PROCESSES.get(key) is process:
                    ACTIVE_PROCESSES.pop(key, None)
            CANCELLED_PIDS.discard(process.pid)


def read_final_assistant_message(session_id: str | None) -> str | None:
    if not session_id or not PROFILE_STATE_DB.is_file():
        return None
    try:
        connection = sqlite3.connect(
            f"file:{PROFILE_STATE_DB}?mode=ro",
            uri=True,
            timeout=2,
        )
        try:
            row = connection.execute(
                """
                SELECT content
                FROM messages
                WHERE session_id = ?
                  AND role = 'assistant'
                  AND finish_reason = 'stop'
                  AND active = 1
                  AND trim(coalesce(content, '')) <> ''
                ORDER BY id DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error:
        return None
    if not row:
        return None
    answer = str(row[0] or "").strip()
    return answer or None


def run_hermes(
    user_text: str,
    session_id: str | None,
    workspace: Path,
    task_id: str,
    context_id: str,
) -> tuple[str, str | None]:
    args = [
        HERMES_BIN,
        "-p",
        PROFILE,
        "chat",
        "-q",
        build_prompt(user_text),
        "-Q",
        "--skills",
        HERMES_SKILLS,
        "--toolsets",
        HERMES_TOOLSETS,
        "--source",
        "tool",
        "--max-turns",
        str(HERMES_MAX_TURNS),
        "--yolo",
    ]
    if session_id:
        args.extend(["--resume", session_id])
    stdout, stderr, returncode = run_process(args, workspace, task_id, context_id)
    discovered = SESSION_ID_RE.findall(stderr or "")
    next_session_id = discovered[-1] if discovered else session_id
    if returncode != 0:
        raise HermesRunError(f"{AGENT_NAME}执行失败（退出码 {returncode}），请稍后重试或缩小任务范围")
    answer = read_final_assistant_message(next_session_id)
    if not answer:
        answer_lines = [
            line
            for line in (stdout or "").splitlines()
            if not line.startswith("Warning: Unknown toolsets:")
        ]
        answer = "\n".join(answer_lines).strip()
    if not answer:
        raise HermesRunError(f"{AGENT_NAME}没有返回可识别结果")
    return answer[:MAX_RESPONSE_CHARS], next_session_id


def safe_artifact(path: Path, workspace: Path) -> tuple[Path, str] | None:
    try:
        resolved = path.resolve(strict=True)
        relative = resolved.relative_to(workspace).as_posix()
    except (OSError, ValueError):
        return None
    if not resolved.is_file() or resolved.suffix.lower() not in ALLOWED_ARTIFACT_SUFFIXES:
        return None
    if relative in {"AGENTS.md", ".ea-context.json"} or relative.startswith("reference/"):
        return None
    if any(part in {".git", "node_modules", ".cache"} for part in resolved.parts):
        return None
    return resolved, relative


def recent_artifacts(started_at: float, workspace: Path) -> list[tuple[Path, str]]:
    rows: list[tuple[float, Path, str]] = []
    for candidate in workspace.rglob("*"):
        item = safe_artifact(candidate, workspace)
        if not item:
            continue
        resolved, relative = item
        relative_parts = set(Path(relative).parts)
        if resolved.suffix.lower() not in PRESENTABLE_ARTIFACT_SUFFIXES:
            continue
        if relative_parts.intersection(INTERNAL_ARTIFACT_DIRS):
            continue
        try:
            modified = resolved.stat().st_mtime
        except OSError:
            continue
        if modified >= started_at - 2:
            rows.append((modified, resolved, relative))
    rows.sort(key=lambda row: row[0], reverse=True)
    return [(path, relative) for _, path, relative in rows[:20]]


def download_signature(key: str, relative: str, expires: int) -> str:
    digest = hmac.new(
        DOWNLOAD_SECRET.encode("utf-8"),
        f"{key}\n{relative}\n{expires}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def download_url(key: str, relative: str) -> str:
    expires = int(time.time()) + DOWNLOAD_TTL_SECONDS
    signature = download_signature(key, relative, expires)
    artifact_path = f"{quote(key, safe='')}/{quote(relative, safe='/')}"
    return f"{PUBLIC_BASE_URL}/files/{artifact_path}?expires={expires}&sig={signature}"


def artifact_file_parts(artifacts: list[tuple[Path, str]], key: str) -> list[dict]:
    parts = []
    for path, relative in artifacts:
        suffix = path.suffix.lower()
        role = "preview" if suffix in {".png", ".jpg", ".jpeg", ".webp", ".pdf"} else "primary"
        artifact_id = f"artifact-{hashlib.sha256(relative.encode('utf-8')).hexdigest()[:20]}"
        parts.append({
            "kind": "file",
            "file": {
                "name": path.name,
                "mimeType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "uri": download_url(key, relative),
                "size": path.stat().st_size,
            },
            "metadata": {
                "schema": "ea.artifact.v1",
                "id": artifact_id,
                "ea.role": role,
            },
        })
    return parts


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    try:
        handler.end_headers()
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


def agent_card() -> dict:
    return {
        "name": AGENT_NAME,
        "description": AGENT_DESCRIPTION,
        "version": "0.1.0",
        "protocolVersion": "0.3.0",
        "url": PUBLIC_BASE_URL,
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/markdown"],
        "skills": [
            {
                "id": AGENT_SKILL_ID,
                "name": AGENT_SKILL_NAME,
                "description": AGENT_SKILL_DESCRIPTION,
                "tags": AGENT_SKILL_TAGS,
            }
        ],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "HermesProfileA2A/0.3"

    def log_message(self, fmt: str, *args: object) -> None:
        status = str(args[1]) if len(args) > 1 else "-"
        request_path = urlparse(self.path).path
        LOGGER.info(
            "%s %s %s %s %s",
            self.log_date_time_string(),
            self.address_string(),
            self.command,
            request_path,
            status,
        )

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, f"Bearer {BEARER_TOKEN}")

    def do_get(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in {"/health", "/readyz"}:
            active = active_task_count()
            json_response(self, 200, {
                "ok": True,
                "profile": PROFILE,
                "activeTasks": active,
                "capacity": MAX_CONCURRENT_TASKS,
                "toolsets": HERMES_TOOLSETS.split(","),
                "taskTimeoutSeconds": TASK_TIMEOUT_SECONDS,
                "maxTurns": HERMES_MAX_TURNS,
                "workspaceKind": WORKSPACE_KIND,
                "contextTtlSeconds": CONTEXT_TTL_SECONDS,
                "busy": active >= MAX_CONCURRENT_TASKS,
            })
            return
        if parsed.path in {"/.well-known/agent-card.json", "/agent-card.json"}:
            json_response(self, 200, agent_card())
            return
        if parsed.path.startswith("/files/"):
            self.serve_artifact(parsed)
            return
        json_response(self, 404, {"error": "not found"})

    def serve_artifact(self, parsed) -> None:
        raw_path = unquote(parsed.path[len("/files/"):]).lstrip("/")
        key, separator, relative = raw_path.partition("/")
        if not separator or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", key):
            json_response(self, 404, {"error": "artifact not found"})
            return
        query = parse_qs(parsed.query)
        try:
            expires = int((query.get("expires") or ["0"])[0])
        except ValueError:
            expires = 0
        supplied = (query.get("sig") or [""])[0]
        expected = download_signature(key, relative, expires)
        if expires < int(time.time()) or not supplied or not hmac.compare_digest(supplied, expected):
            json_response(self, 403, {"error": "download link expired or invalid"})
            return
        workspace = existing_workspace_for_context(key)
        if workspace is None:
            json_response(self, 404, {"error": "artifact not found"})
            return
        item = safe_artifact(workspace / relative, workspace)
        if not item:
            json_response(self, 404, {"error": "artifact not found"})
            return
        path, _ = item
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        inline_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".pdf", ".txt", ".md", ".json"}
        disposition = "inline" if path.suffix.lower() in inline_suffixes else "attachment"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(path.name)}")
        self.send_header("Cache-Control", "private, max-age=300")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as handle:
            chunk = handle.read(1024 * 1024)
            while chunk:
                self.wfile.write(chunk)
                chunk = handle.read(1024 * 1024)

    def do_post(self) -> None:
        if urlparse(self.path).path not in {"/", "/a2a", "/rpc"}:
            json_response(self, 404, {"error": "not found"})
            return
        if not self.authorized():
            error = {"code": -32001, "message": "unauthorized"}
            json_response(self, 401, {"jsonrpc": "2.0", "id": None, "error": error})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            json_response(self, 413, {"error": "request body is empty or too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            error = {"code": -32700, "message": "parse error"}
            json_response(self, 400, {"jsonrpc": "2.0", "id": None, "error": error})
            return
        request_id = payload.get("id") if isinstance(payload, dict) else None
        method = payload.get("method") if isinstance(payload, dict) else None
        if method == "tasks/cancel":
            params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
            context_id = re.sub(r"[^A-Za-z0-9_.:-]", "", str(params.get("contextId") or ""))[:128]
            remote_task_id = re.sub(r"[^A-Za-z0-9_.:-]", "", str(params.get("id") or ""))[:128]
            cancelled = cancel_active_process(remote_task_id, context_id)
            if context_id:
                forget_session(context_id)
            result = {
                "kind": "task",
                "id": remote_task_id or str(uuid.uuid4()),
                "contextId": context_id or None,
                "status": {"state": "canceled" if cancelled else "completed"},
            }
            json_response(self, 200, {"jsonrpc": "2.0", "id": request_id, "result": result})
            return
        if method not in {"message/send", "tasks/send"}:
            error = {"code": -32601, "message": "method not found"}
            json_response(self, 200, {"jsonrpc": "2.0", "id": request_id, "error": error})
            return
        user_text = extract_text(payload)
        if not user_text:
            error = {"code": -32602, "message": "message text is required"}
            json_response(self, 400, {"jsonrpc": "2.0", "id": request_id, "error": error})
            return
        key = context_key(payload)
        request_task_id = task_key(payload)
        task_lock = acquire_task_slot(key)
        if task_lock is None:
            error = {"code": -32002, "message": f"{AGENT_NAME}当前任务较多"}
            json_response(self, 429, {"jsonrpc": "2.0", "id": request_id, "error": error})
            return
        started_at = time.time()
        try:
            workspace = workspace_for_context(key)
            session_id = read_session(key)
            is_connection_test = bool(CONNECTION_TEST_RE.search(user_text))
            if RESET_RE.search(user_text) or is_connection_test:
                session_id = None
                if not is_connection_test:
                    forget_session(key)
            answer, next_session_id = run_hermes(user_text, session_id, workspace, request_task_id, key)
            if next_session_id and not is_connection_test and key != "default":
                remember_session(key, next_session_id)
            visible_answer, interaction = extract_interaction(answer)
            artifact_parts = artifact_file_parts(recent_artifacts(started_at, workspace), key)
            artifacts_missing = not interaction and not artifact_parts
            if REQUIRE_ARTIFACTS and not is_connection_test and artifacts_missing:
                raise HermesRunError("专家未在本次隔离工作区生成可交付文件，任务未完成")
            if interaction:
                parts = []
                if visible_answer:
                    parts.append({"kind": "text", "text": visible_answer})
                parts.extend(artifact_parts)
                parts.append({
                    "kind": "data",
                    "data": interaction,
                    "metadata": {"key": "ea.interaction", "version": "1.0.0"},
                })
                result = {
                    "kind": "task",
                    "id": request_task_id or str(uuid.uuid4()),
                    "contextId": key,
                    "status": {
                        "state": "input-required",
                        "message": {
                            "kind": "message",
                            "role": "agent",
                            "messageId": str(uuid.uuid4()),
                            "contextId": key,
                            "parts": parts,
                        },
                    },
                }
            else:
                parts = []
                if visible_answer:
                    parts.append({"kind": "text", "text": visible_answer})
                parts.extend(artifact_parts)
                result = {
                    "kind": "message",
                    "role": "agent",
                    "messageId": str(uuid.uuid4()),
                    "contextId": key,
                    "parts": parts,
                }
            json_response(self, 200, {"jsonrpc": "2.0", "id": request_id, "result": result})
        except HermesRunError as error:
            message = redact_error(str(error))
            response_error = {"code": -32010, "message": message}
            json_response(self, 500, {"jsonrpc": "2.0", "id": request_id, "error": response_error})
        except Exception as error:
            message = redact_error(str(error) or "internal error")
            response_error = {"code": -32603, "message": message}
            json_response(self, 500, {"jsonrpc": "2.0", "id": request_id, "error": response_error})
        finally:
            release_task_slot(task_lock)


# BaseHTTPRequestHandler dispatches these exact HTTP verb method names.
setattr(Handler, "do_GET", Handler.do_get)
setattr(Handler, "do_POST", Handler.do_post)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    require_secure_config()
    cleanup_stale_contexts()
    cleanup_thread = threading.Thread(target=cleanup_loop, name="a2a-context-cleanup", daemon=True)
    cleanup_thread.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    LOGGER.info(
        "Hermes A2A listening on %s:%s; profile=%s; workspaceKind=%s",
        HOST,
        PORT,
        PROFILE,
        WORKSPACE_KIND,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        CLEANUP_STOP.set()
        with PROCESS_LOCK:
            processes = list({process.pid: process for process in ACTIVE_PROCESSES.values()}.values())
        for process in processes:
            _terminate_process(process)
        server.server_close()


if __name__ == "__main__":
    main()
