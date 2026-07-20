#!/usr/bin/env python3
"""Apply the minimal EA runtime configuration to a JiuwenSwarm workspace."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import dotenv_values
from ruamel.yaml import YAML


def update_env(path: Path, values: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(values)
    output: list[str] = []
    for line in lines:
        if "=" not in line or line.lstrip().startswith("#"):
            output.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in pending:
            output.append(f"{key}={pending.pop(key)}")
        else:
            output.append(line)
    if output and output[-1]:
        output.append("")
    output.extend(f"{key}={value}" for key, value in pending.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    path.chmod(0o600)


def upsert_managed_mcp_servers(config: dict, port: int) -> None:
    mcp = config.setdefault("mcp", {})
    servers = mcp.setdefault("servers", [])
    if not isinstance(servers, list):
        servers = []
        mcp["servers"] = servers
    desired_servers = [
        {
            "name": "platform_tools",
            "enabled": True,
            "transport": "streamable-http",
            "url": f"http://127.0.0.1:{port}/api/internal/platform-tools/mcp",
            "headers": {"x-internal-key": "${INTERNAL_API_KEY}"},
            "user_context": True,
            "timeout_s": 30,
        },
        {
            "name": "custom_mcp_gateway",
            "enabled": True,
            "transport": "streamable-http",
            "url": f"http://127.0.0.1:{port}/api/internal/custom-mcp/mcp",
            "headers": {"x-internal-key": "${INTERNAL_API_KEY}"},
            "user_context": True,
            "timeout_s": 65,
        },
    ]
    for desired in desired_servers:
        server = next(
            (item for item in servers if isinstance(item, dict) and item.get("name") == desired["name"]),
            None,
        )
        if server is None:
            servers.append(desired)
        else:
            server.clear()
            server.update(desired)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--runtime-env", required=True)
    parser.add_argument("--ea-env", required=True)
    parser.add_argument("--port", type=int, default=5180)
    args = parser.parse_args()

    config_path = Path(args.config).expanduser().resolve()
    runtime_env_path = Path(args.runtime_env).expanduser().resolve()
    ea_env = dotenv_values(Path(args.ea_env).expanduser().resolve())
    internal_key = str(ea_env.get("INTERNAL_API_KEY") or "").strip()
    if not internal_key:
        raise SystemExit("EA INTERNAL_API_KEY is missing")

    yaml = YAML()
    yaml.preserve_quotes = True
    with config_path.open("r", encoding="utf-8") as handle:
        config = yaml.load(handle) or {}

    react = config.setdefault("react", {})
    react["skill_mode"] = "auto_list"

    channels = config.setdefault("channels", {})
    linggan = channels.setdefault("linggan", {})
    linggan.update(
        {
            "enabled": True,
            "callback_url": "${LINGGAN_CALLBACK_URL}",
            "token": "${LINGGAN_CALLBACK_TOKEN}",
            "timeout_seconds": 10,
            "send_file_allowed": True,
        }
    )
    upsert_managed_mcp_servers(config, args.port)

    with config_path.open("w", encoding="utf-8") as handle:
        yaml.dump(config, handle)
    config_path.chmod(0o600)

    update_env(
        runtime_env_path,
        {
            "INTERNAL_API_KEY": internal_key,
            "WORKFORCE_AGENT_INTERNAL_BASE_URL": f"http://127.0.0.1:{args.port}",
            "JIUWENSWARM_DATA_DIR": str(config_path.parent.parent),
            "LINGGAN_CALLBACK_URL": f"http://127.0.0.1:{args.port}/api/internal/jiuwen/linggan/callback",
            "LINGGAN_CALLBACK_TOKEN": internal_key,
            "JIUWENSWARM_WORKSPACE_ISOLATION": "deny",
            "JIUWENSWARM_DISABLED_SKILL_TOOLS": "search_skill,install_skill,uninstall_skill",
        },
    )
    os.chmod(config_path.parent, 0o700)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
