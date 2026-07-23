import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("hermes_profile_a2a_server", MODULE_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(SERVER)


class HermesProfileA2ATest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.previous = {
            "WORKSPACES_ROOT": SERVER.WORKSPACES_ROOT,
            "STATE_FILE": SERVER.STATE_FILE,
            "CONTEXT_TTL_SECONDS": SERVER.CONTEXT_TTL_SECONDS,
            "MAX_CONTEXTS": SERVER.MAX_CONTEXTS,
            "WORKSPACE_KIND": SERVER.WORKSPACE_KIND,
        }
        SERVER.WORKSPACES_ROOT = root / "workspaces"
        SERVER.STATE_FILE = root / "state.json"
        SERVER.CONTEXT_TTL_SECONDS = 100
        SERVER.MAX_CONTEXTS = 8
        SERVER.WORKSPACE_KIND = "generic"
        SERVER.WORKSPACES_ROOT.mkdir()

    def tearDown(self):
        for key, value in self.previous.items():
            setattr(SERVER, key, value)
        self.temp.cleanup()

    def test_task_and_context_keys_are_bounded(self):
        payload = {
            "id": "rpc-id",
            "params": {"message": {"contextId": "ea-context:1", "taskId": "agt_123"}},
        }
        self.assertEqual(SERVER.context_key(payload), "ea-context:1")
        self.assertEqual(SERVER.task_key(payload), "agt_123")

    def test_existing_workspace_lookup_does_not_create_directory(self):
        self.assertIsNone(SERVER.existing_workspace_for_context("missing"))
        self.assertEqual(list(SERVER.WORKSPACES_ROOT.iterdir()), [])

    def test_cleanup_removes_only_expired_workspace(self):
        now = int(time.time())
        fresh = SERVER.workspace_for_context("fresh")
        stale = SERVER.workspace_for_context("stale")
        (fresh / ".ea-context.json").write_text(
            json.dumps({"contextId": "fresh", "updatedAt": now}), encoding="utf-8"
        )
        (stale / ".ea-context.json").write_text(
            json.dumps({"contextId": "stale", "updatedAt": now - 101}), encoding="utf-8"
        )

        self.assertEqual(SERVER.cleanup_stale_contexts(now), 1)
        self.assertTrue(fresh.is_dir())
        self.assertFalse(stale.exists())

    def test_context_marker_is_not_a_public_artifact(self):
        workspace = SERVER.workspace_for_context("artifact-test")
        self.assertIsNone(SERVER.safe_artifact(workspace / ".ea-context.json", workspace))

    def test_cancel_stops_only_the_registered_process_group(self):
        process = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            with SERVER.PROCESS_LOCK:
                SERVER.ACTIVE_PROCESSES["task:agt_cancel"] = process
                SERVER.ACTIVE_PROCESSES["context:ea-cancel"] = process
            self.assertTrue(SERVER.cancel_active_process("agt_cancel", "ea-cancel"))
            process.wait(timeout=2)
            self.assertIsNotNone(process.returncode)
        finally:
            with SERVER.PROCESS_LOCK:
                SERVER.ACTIVE_PROCESSES.clear()
                SERVER.CANCELLED_PIDS.discard(process.pid)
            if process.poll() is None:
                process.kill()

    def test_error_redaction_covers_bare_known_secret_values(self):
        secret = "0123456789abcdef0123456789abcdef"
        with patch.dict("os.environ", {"MODEL_PROVIDER_API_KEY": secret}, clear=False):
            message = SERVER.redact_error(f"provider failed with {secret}")
        self.assertNotIn(secret, message)
        self.assertIn("[REDACTED]", message)

    def test_nonzero_hermes_exit_does_not_return_child_stderr(self):
        secret = "fedcba9876543210fedcba9876543210"
        workspace = SERVER.workspace_for_context("failed-run")
        with patch.object(SERVER, "run_process", return_value=("", f"failure {secret}", 2)):
            with self.assertRaises(SERVER.HermesRunError) as raised:
                SERVER.run_hermes("test", None, workspace, "agt_failed", "failed-run")
        self.assertNotIn(secret, str(raised.exception))
        self.assertIn("退出码 2", str(raised.exception))

    def test_subprocess_environment_drops_secrets_but_keeps_runtime_context(self):
        with patch.dict("os.environ", {
            "A2A_BEARER_TOKEN": "a" * 32,
            "MODEL_PROVIDER_API_KEY": "b" * 32,
            "PATH": "/usr/bin",
            "HERMES_PROFILE": "ppt-expert",
        }, clear=True):
            process_env = SERVER.subprocess_environment()
        self.assertNotIn("A2A_BEARER_TOKEN", process_env)
        self.assertNotIn("MODEL_PROVIDER_API_KEY", process_env)
        self.assertEqual(process_env["PATH"], "/usr/bin")
        self.assertEqual(process_env["HERMES_PROFILE"], "ppt-expert")

    def test_profile_credentials_cannot_override_runtime_paths(self):
        credentials = Path(self.temp.name) / "credentials.env"
        credentials.write_text(
            "A2A_BEARER_TOKEN=new-token-value\n"
            "HERMES_BIN=/tmp/untrusted-hermes\n",
            encoding="utf-8",
        )
        with patch.dict("os.environ", {
            "A2A_BEARER_TOKEN": "old-token-value",
            "HERMES_BIN": "/usr/bin/hermes",
        }, clear=False):
            SERVER.load_env(
                credentials,
                override=True,
                allowed_keys={"A2A_BEARER_TOKEN", "A2A_DOWNLOAD_SECRET"},
            )
            self.assertEqual(os.environ["A2A_BEARER_TOKEN"], "new-token-value")
            self.assertEqual(os.environ["HERMES_BIN"], "/usr/bin/hermes")


if __name__ == "__main__":
    unittest.main()
