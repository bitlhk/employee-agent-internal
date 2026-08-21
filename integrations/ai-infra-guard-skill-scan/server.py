#!/usr/bin/env python3
"""Internal HTTP wrapper for Tencent AI-Infra-Guard security scan CLIs."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_PACKAGE_BYTES = int(os.environ.get("AIG_SKILL_SCAN_MAX_PACKAGE_BYTES", 20 * 1024 * 1024))
MAX_ENTRIES = int(os.environ.get("AIG_SKILL_SCAN_MAX_ENTRIES", 2_000))
MAX_EXTRACTED_BYTES = int(os.environ.get("AIG_SKILL_SCAN_MAX_EXTRACTED_BYTES", 100 * 1024 * 1024))
MAX_MCP_PACKAGE_BYTES = int(os.environ.get("AIG_MCP_SCAN_MAX_PACKAGE_BYTES", 30 * 1024 * 1024))
SCAN_TIMEOUT_SECONDS = int(os.environ.get("AIG_SKILL_SCAN_TIMEOUT_SECONDS", 600))
MCP_SCAN_TIMEOUT_SECONDS = int(os.environ.get("AIG_MCP_SCAN_TIMEOUT_SECONDS", 1200))
SCAN_CONCURRENCY = max(1, int(os.environ.get("AIG_SKILL_SCAN_CONCURRENCY", 1)))
SCAN_SEMAPHORE = threading.BoundedSemaphore(SCAN_CONCURRENCY)


def _read_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path or not os.path.isfile(path):
        return values
    with open(path, encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("\"'")
    return values


def _scanner_config() -> dict[str, str]:
    fallback = _read_env_file(os.environ.get("AIG_SKILL_SCAN_MODEL_ENV_PATH", ""))
    return {
        "binary": os.environ.get("AIG_SKILL_SCAN_BIN", "aig-skill-scan"),
        "mcp_binary": os.environ.get("AIG_MCP_SCAN_BIN", "aig-mcp-scan"),
        "api_key": os.environ.get("AIG_SKILL_SCAN_API_KEY", fallback.get("API_KEY", "")),
        "base_url": os.environ.get(
            "AIG_SKILL_SCAN_BASE_URL", fallback.get("API_BASE", "https://openrouter.ai/api/v1")
        ),
        "model": os.environ.get(
            "AIG_SKILL_SCAN_MODEL", fallback.get("MODEL_NAME", "deepseek-v4-flash")
        ),
    }


def _safe_extract_source(package_path: Path, target: Path) -> Path:
    with zipfile.ZipFile(package_path) as archive:
        members = archive.infolist()
        if not members or len(members) > MAX_ENTRIES:
            raise ValueError("source package contains an invalid number of entries")
        total_bytes = 0
        roots: set[str] = set()
        files = 0
        for member in members:
            name = member.filename.replace("\\", "/")
            parts = [part for part in name.split("/") if part and part != "."]
            if not parts or name.startswith("/") or ".." in parts or ":" in parts[0]:
                raise ValueError("source package contains an invalid path")
            mode = (member.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ValueError("source package symbolic links are not allowed")
            total_bytes += member.file_size
            if total_bytes > MAX_EXTRACTED_BYTES:
                raise ValueError("source package extracted size exceeds limit")
            roots.add(parts[0])
            if not member.is_dir():
                files += 1
        if files == 0:
            raise ValueError("source package does not contain files")
        archive.extractall(target)
    if len(roots) == 1:
        candidate = target / next(iter(roots))
        if candidate.is_dir():
            return candidate
    return target


def _safe_extract(package_path: Path, target: Path) -> Path:
    with zipfile.ZipFile(package_path) as archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES:
            raise ValueError("skill package contains too many entries")

        total_bytes = 0
        roots: set[str] = set()
        for member in members:
            name = member.filename.replace("\\", "/")
            parts = [part for part in name.split("/") if part and part != "."]
            if not parts or name.startswith("/") or ".." in parts or ":" in parts[0]:
                raise ValueError("skill package contains an invalid path")
            mode = (member.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ValueError("skill package symbolic links are not allowed")
            total_bytes += member.file_size
            if total_bytes > MAX_EXTRACTED_BYTES:
                raise ValueError("skill package extracted size exceeds limit")
            roots.add(parts[0])

        archive.extractall(target)

    if len(roots) == 1:
        candidate = target / next(iter(roots))
        if candidate.is_dir() and (candidate / "SKILL.md").is_file():
            return candidate
    if (target / "SKILL.md").is_file():
        return target

    matches = list(target.glob("**/SKILL.md"))
    if len(matches) != 1:
        raise ValueError("skill package must contain exactly one SKILL.md root")
    return matches[0].parent


def _scan_package(body: bytes, expected_sha256: str) -> dict[str, Any]:
    actual_sha256 = hashlib.sha256(body).hexdigest()
    if expected_sha256 and expected_sha256 != actual_sha256:
        raise ValueError("skill package fingerprint mismatch")

    config = _scanner_config()
    if not config["api_key"]:
        raise RuntimeError("skill scanner model credential is not configured")
    binary = shutil.which(config["binary"])
    if not binary:
        raise RuntimeError("aig-skill-scan executable is unavailable")

    with tempfile.TemporaryDirectory(prefix="grace-aig-skill-") as temp_dir:
        root = Path(temp_dir)
        package_path = root / "skill.zip"
        extract_path = root / "source"
        output_path = root / "result.sarif.json"
        package_path.write_bytes(body)
        extract_path.mkdir()
        skill_root = _safe_extract(package_path, extract_path)
        process_env = os.environ.copy()
        process_env["LLM_API_KEY"] = config["api_key"]
        completed = subprocess.run(
            [
                binary,
                "--repo",
                str(skill_root),
                "--model",
                config["model"],
                "--base_url",
                config["base_url"],
                "--language",
                "zh",
                "--output",
                str(output_path),
            ],
            cwd=root,
            env=process_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=SCAN_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0 or not output_path.is_file():
            detail = completed.stdout[-2_000:].strip()
            raise RuntimeError(f"aig-skill-scan failed ({completed.returncode}): {detail}")
        sarif = json.loads(output_path.read_text(encoding="utf-8"))
        return {
            "status": "completed",
            "subjectFingerprint": actual_sha256,
            "scanner": {
                "name": "aig-skill-scan",
                "version": str(
                    sarif.get("runs", [{}])[0].get("tool", {}).get("driver", {}).get("version", "unknown")
                ),
                "source": "https://github.com/Tencent/AI-Infra-Guard",
            },
            "sarif": sarif,
        }


def _scan_mcp_package(body: bytes, expected_sha256: str) -> dict[str, Any]:
    actual_sha256 = hashlib.sha256(body).hexdigest()
    if expected_sha256 and expected_sha256 != actual_sha256:
        raise ValueError("MCP source package fingerprint mismatch")
    config = _scanner_config()
    if not config["api_key"]:
        raise RuntimeError("MCP scanner model credential is not configured")
    binary = shutil.which(config["mcp_binary"])
    if not binary:
        raise RuntimeError("aig-mcp-scan executable is unavailable")
    with tempfile.TemporaryDirectory(prefix="grace-aig-mcp-") as temp_dir:
        root = Path(temp_dir)
        package_path = root / "source.zip"
        extract_path = root / "source"
        output_path = root / "result.sarif.json"
        package_path.write_bytes(body)
        extract_path.mkdir()
        source_root = _safe_extract_source(package_path, extract_path)
        process_env = os.environ.copy()
        process_env["LLM_API_KEY"] = config["api_key"]
        completed = subprocess.run(
            [
                binary,
                "--repo",
                str(source_root),
                "--model",
                config["model"],
                "--base_url",
                config["base_url"],
                "--language",
                "zh",
                "--output",
                str(output_path),
            ],
            cwd=root,
            env=process_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=MCP_SCAN_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0 or not output_path.is_file():
            detail = completed.stdout[-2_000:].strip()
            raise RuntimeError(f"aig-mcp-scan failed ({completed.returncode}): {detail}")
        sarif = json.loads(output_path.read_text(encoding="utf-8"))
        return {
            "status": "completed",
            "subjectFingerprint": actual_sha256,
            "scanner": {
                "name": "aig-mcp-scan",
                "version": str(
                    sarif.get("runs", [{}])[0].get("tool", {}).get("driver", {}).get("version", "unknown")
                ),
                "source": "https://github.com/Tencent/AI-Infra-Guard",
            },
            "sarif": sarif,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "GRACE-AIG-Skill-Scan/1.0"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        expected = os.environ.get("AIG_SKILL_SCAN_SERVICE_TOKEN", "")
        return not expected or self.headers.get("Authorization", "") == f"Bearer {expected}"

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        config = _scanner_config()
        self._json(
            HTTPStatus.OK,
            {
                "ok": True,
                "service": "grace-aig-security-scan",
                "scannerAvailable": bool(shutil.which(config["binary"])),
                "scanners": {
                    "skill": bool(shutil.which(config["binary"])),
                    "mcp": bool(shutil.which(config["mcp_binary"])),
                },
                "modelConfigured": bool(config["api_key"] and config["model"] and config["base_url"]),
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/v1/skill-scans", "/v1/mcp-scans"}:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        max_bytes = MAX_MCP_PACKAGE_BYTES if self.path == "/v1/mcp-scans" else MAX_PACKAGE_BYTES
        if length <= 0 or length > max_bytes:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid package size"})
            return
        if not SCAN_SEMAPHORE.acquire(blocking=False):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "scanner is busy"})
            return
        try:
            body = self.rfile.read(length)
            fingerprint = self.headers.get("X-Subject-SHA256", "").strip().lower()
            result = _scan_mcp_package(body, fingerprint) if self.path == "/v1/mcp-scans" else _scan_package(body, fingerprint)
            self._json(HTTPStatus.OK, result)
        except subprocess.TimeoutExpired:
            self._json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "security scan timed out"})
        except (ValueError, zipfile.BadZipFile) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            self._json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)[:2_000]})
        finally:
            SCAN_SEMAPHORE.release()

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[grace-aig-skill-scan] {self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    host = os.environ.get("AIG_SKILL_SCAN_HOST", "127.0.0.1")
    port = int(os.environ.get("AIG_SKILL_SCAN_PORT", "18920"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[grace-aig-skill-scan] listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
