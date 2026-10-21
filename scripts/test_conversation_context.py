import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

# Exercise the installed runtime's real history serializer in a disposable home.
# Run with the configured JiuwenSwarm Python, not the application's Python.
_home = tempfile.TemporaryDirectory(prefix="ea-context-test-")
os.environ["JIUWENSWARM_DATA_DIR"] = _home.name
os.environ["INTERNAL_RUNTIME_TOKEN_SECRET"] = "fixture-secret-only"
from jiuwenswarm.server.runtime.session import session_history as history
from jiuwen_conversation_context import append_signed_context, with_conversation_context, mcp_request_session_id


class ConversationContextTests(unittest.TestCase):
    def test_transport_task_uses_the_actual_call_metadata_instead_of_stale_context(self):
        from types import SimpleNamespace
        def request(sid, method="tools/call"):
            return SimpleNamespace(content=json.dumps({"method": method, "params": {"_meta": {"ea_session_id": sid}}}).encode())
        self.assertEqual(mcp_request_session_id(request("sess_actual_A"), "sess_stale"), "sess_actual_A")
        self.assertEqual(mcp_request_session_id(request("sess_actual_B"), "sess_stale"), "sess_actual_B")
        self.assertEqual(mcp_request_session_id(request("../../escape"), "sess_stale"), "sess_stale")
        self.assertEqual(mcp_request_session_id(request("sess_actual_A", "initialize"), None), None)
        self.assertEqual(mcp_request_session_id(SimpleNamespace(content=b"invalid"), "sess_fallback"), "sess_fallback")

    def delivery(self, suffix="a", **patch):
        payload = {"sessionId": "sess_context_fixture", "adoptId": "lgj-fixture",
                   "messageId": "ea-context-" + suffix * 64, "content": "日程已创建",
                   "issuedAt": time.time(), "timestamp": time.time(),
                   "context": {"resource": "run:fixture", "actions": []}, **patch}
        raw = json.dumps(payload, ensure_ascii=False)
        return {"ea_payload": raw, "ea_signature": hmac.new(b"fixture-secret-only", raw.encode(), hashlib.sha256).hexdigest()}

    def setUp(self):
        path = history.get_write_history_path("sess_context_fixture")
        self.assertTrue(str(path.resolve()).startswith(str(Path(_home.name).resolve())))
        if path.exists():
            path.unlink()

    def test_durable_ack_retry_and_model_context_after_reload(self):
        self.assertEqual(append_signed_context(self.delivery()), {"persisted": True, "duplicate": False})
        self.assertTrue(append_signed_context(self.delivery())["duplicate"])
        rows = history.load_history_records("sess_context_fixture")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event_type"], "chat.final")
        inputs = {"query": "刚才安排好了吗？"}
        enriched = with_conversation_context(inputs, "sess_context_fixture")
        self.assertIn("日程已创建", enriched["query"])
        self.assertEqual(inputs, {"query": "刚才安排好了吗？"})
        self.assertEqual(with_conversation_context(inputs, "ea_collab_fixture"), inputs)

    def test_new_status_supersedes_previous_status_in_model_context(self):
        append_signed_context(self.delivery(content="等待回复"))
        append_signed_context(self.delivery("b", content="会议已经取消"))
        self.assertEqual(len(history.load_history_records("sess_context_fixture")), 2)
        query = with_conversation_context({"query": "状态"}, "sess_context_fixture")["query"]
        self.assertNotIn("等待回复", query)
        self.assertIn("会议已经取消", query)

    def test_invalid_signature_expiry_and_path_cannot_append(self):
        bad = self.delivery()
        bad["ea_signature"] = "wrong"
        for params in [bad, self.delivery(issuedAt=0), self.delivery(sessionId="../../escape")]:
            with self.assertRaises(ValueError):
                append_signed_context(params)
        self.assertEqual(history.load_history_records("sess_context_fixture"), [])


if __name__ == "__main__":
    unittest.main()
