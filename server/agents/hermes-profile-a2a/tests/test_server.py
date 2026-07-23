import importlib.util
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
