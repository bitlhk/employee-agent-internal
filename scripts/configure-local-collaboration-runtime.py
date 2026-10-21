from __future__ import annotations
import argparse
import importlib.util
from importlib.metadata import version
import json
import os
import getpass
from pathlib import Path
import shutil
import subprocess
import sys
import yaml
import certifi
from dotenv import dotenv_values

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--ea-env", type=Path, required=True)
parser.add_argument("--port", type=int, required=True)
args = parser.parse_args()
values = json.load(sys.stdin)
if version("openjiuwen") == "0.1.16" and version("filelock") != "3.25.0":
    raise RuntimeError("Install scripts/requirements-local-collaboration-runtime.txt into this runtime before configuring it; openjiuwen 0.1.16 requires the verified filelock compatibility pin")
import jiuwenswarm
package = Path(jiuwenswarm.__file__).resolve().parent
from patch_jiuwenswarm_collaboration import patch
patch(package.parent)
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=True)
if os.name == "nt":
    subprocess.run(["icacls", str(root), "/inheritance:r", "/grant:r", f"{getpass.getuser()}:(OI)(CI)F", "SYSTEM:(OI)(CI)F"], check=True, capture_output=True)
config_dir = root / "config"
config_dir.mkdir(parents=True, exist_ok=True)
config_file = config_dir / "config.yaml"
if not config_file.exists():
    shutil.copyfile(package / "resources/config.yaml", config_file)
rules = package / "resources/builtin_rules.yaml"
if rules.exists() and not (config_dir / rules.name).exists():
    shutil.copyfile(rules, config_dir / rules.name)

config = yaml.safe_load(config_file.read_text(encoding="utf-8"))
model_config = config["models"]["defaults"][0]
model_config["model_client_config"].update({"api_base": "${API_BASE}", "api_key": "${API_KEY}", "model_name": "${MODEL_NAME}", "client_provider": "OpenAI", "verify_ssl": True, "ssl_cert": certifi.where()})
model_config["model_config_obj"]["temperature"] = 0.2
spec = importlib.util.spec_from_file_location("ea_runtime_configuration", Path(__file__).with_name("configure_jiuwenswarm.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.upsert_managed_mcp_servers(config, args.port)
helper.upsert_governance_hook(config)
for entry in config["hooks"]["PreToolUse"]:
    for hook in entry.get("hooks", []):
        if "jiuwen_pre_tool_hook.py" in str(hook.get("command", "")):
            hook["command"] = subprocess.list2cmdline([values["runtimePython"], str(Path(__file__).with_name("jiuwen_pre_tool_hook.py").resolve())])
            hook["ea_argv"] = [values["runtimePython"], str(Path(__file__).with_name("jiuwen_pre_tool_hook.py").resolve())]
config_file.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
runtime_env = {
    "API_BASE": values["baseUrl"], "API_KEY": values["apiKey"], "MODEL_NAME": values["model"], "MODEL_PROVIDER": "OpenAI",
    "INTERNAL_API_KEY": values["INTERNAL_API_KEY"], "INTERNAL_RUNTIME_TOKEN_SECRET": values["INTERNAL_RUNTIME_TOKEN_SECRET"],
    "JIUWENSWARM_DATA_DIR": str(root), "WORKFORCE_AGENT_INTERNAL_BASE_URL": f"http://127.0.0.1:{args.port}",
    "JIUWENSWARM_RUNTIME_ID": "jiuwenswarm-local", "EA_GOVERNANCE_RULE_VERSION": "ea-governance-v1",
    "JIUWENSWARM_MANAGED_MEMORY": "true", "JIUWENSWARM_DISABLED_SKILL_TOOLS": "search_skill,install_skill,uninstall_skill",
    "AGENT_SERVER_HOST": "127.0.0.1", "AGENT_SERVER_PORT": "18092", "PYTHONUTF8": "1",
    "SAFE_CERT_DIR": str(Path(certifi.where()).parent),
}
(config_dir / ".env").write_text("\n".join(f"{key}={json.dumps(value)}" for key, value in runtime_env.items()) + "\n", encoding="utf-8")
