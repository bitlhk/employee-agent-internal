import ast
import os
import unittest
from unittest.mock import patch as mock_patch
from pathlib import Path
from patch_jiuwenswarm_collaboration import patched_scoped_mcp_arguments
from patch_jiuwenswarm_collaboration import patched_conversation_delivery, patched_conversation_inputs
from patch_jiuwenswarm_collaboration import patched_mcp_session_metadata
from patch_jiuwenswarm_collaboration import patched_windows_identity
from patch_jiuwenswarm_collaboration import patched_mcp_signature
from patch_jiuwenswarm_collaboration import patched_adapter, patched_auth, patched_windows_cert, patched_scoped_catalog, patched_hook_executor, patched_hook_rail, patched_runtime_probe


class RuntimePatchTests(unittest.TestCase):
    def test_mcp_transports_session_in_metadata_without_changing_tool_arguments(self):
        import asyncio
        import sys
        from types import ModuleType, SimpleNamespace
        from contextvars import ContextVar
        from unittest.mock import AsyncMock
        source = 'async def invoke(self, tool_name, arguments):\n            tool_result = await self._session.call_tool(tool_name, arguments=arguments)\n            return tool_result\n'
        result = patched_mcp_session_metadata(source)
        self.assertEqual(patched_mcp_session_metadata(result), result)
        ast.parse(result)
        namespace = {}
        exec(compile(result, '<test>', 'exec'), namespace)
        current = ContextVar('fixture_session')
        module_name = 'jiuwenswarm.server.runtime.agent_adapter.interface_deep'
        module = ModuleType(module_name)
        module.get_runtime_tool_session_id = lambda: current.get(None)
        client = SimpleNamespace(_session=SimpleNamespace(call_tool=AsyncMock()))
        async def call(sid):
            current.set(sid)
            await asyncio.sleep(0)
            await namespace['invoke'](client, 'start_collaboration_goal', {'requestKey': sid})
        async def both():
            await asyncio.gather(call('sess_actual_A'), call('sess_actual_B'))
        with mock_patch.dict(sys.modules, {module_name: module}):
            asyncio.run(both())
        for call_args in client._session.call_tool.call_args_list:
            self.assertEqual(call_args.kwargs['arguments']['requestKey'], call_args.kwargs['meta']['ea_session_id'])

    def test_conversation_delivery_upgrades_old_probe_and_keeps_usage(self):
        source = 'def status():\n            if action == "usage":\n                original_usage()\n'
        old = patched_runtime_probe(source).replace(', "ea_conversation_context_version": 1', '')
        result = patched_conversation_delivery(patched_runtime_probe(old))
        ast.parse(result)
        self.assertIn('"ea_conversation_context_version": 1', result)
        self.assertIn('append_signed_context(params)', result)
        self.assertIn('original_usage()', result)
        self.assertEqual(patched_conversation_delivery(patched_runtime_probe(result)), result)

    def test_both_turn_paths_refresh_context_without_modifying_user_request(self):
        source = 'class Adapter:\n    def first(self):\n            inputs = self._prepare_multimodal_image_inputs(\n                inputs)\n    def second(self):\n            inputs = self._prepare_multimodal_image_inputs(\n                inputs)\n'
        result = patched_conversation_inputs(source)
        ast.parse(result)
        self.assertEqual(result.count('inputs = with_conversation_context(inputs, session_id)'), 2)
        self.assertNotIn('request.params', result)
        self.assertEqual(patched_conversation_inputs(result), result)

    def test_dynamic_token_rotation_does_not_reload_mcp_but_identity_changes_still_do(self):
        import copy
        from types import SimpleNamespace
        source = '''class Adapter:
    def signatures(self, current_cfg, desired_cfg):
        to_check = []
        for server_name in to_check:
            pass
        return getattr(current_cfg, "auth_headers", None), getattr(desired_cfg, "auth_headers", None)
'''
        result = patched_mcp_signature(source)
        namespace = {"copy": copy, "EA_RUNTIME_AUDIENCE_HEADER": "audience", "EA_INTERNAL_MCP_AUDIENCES": {"platform_tools": "platform"}}
        exec(compile(result, '<test>', 'exec'), namespace)
        compare = namespace['Adapter']().signatures
        headers = {"audience": "platform", "authorization": "Bearer first", "x-linggan-agent-id": "alice", "x-ea-collaboration-capability": "grant"}
        current = SimpleNamespace(auth_headers=headers)
        for change, equal in [({"authorization": "Bearer rotated"}, True), ({"x-linggan-agent-id": "bob"}, False), ({"x-ea-collaboration-capability": "new-grant"}, False), ({"audience": "other"}, False)]:
            left, right = compare(current, SimpleNamespace(auth_headers={**headers, **change}))
            self.assertEqual(left == right, equal)
        self.assertEqual(headers['authorization'], 'Bearer first')
        left, right = compare(SimpleNamespace(auth_headers={"authorization": "one"}), SimpleNamespace(auth_headers={"authorization": "two"}))
        self.assertNotEqual(left, right)
        self.assertEqual(patched_mcp_signature(result), result)

    def test_workspace_identity_is_preserved_for_windows_and_posix_paths(self):
        import re
        source = '''def identity(workspace_dir):
        raw = str(workspace_dir or "").strip()
        match = re.search(r"(?:^|/)agent_(jiuwen_(lgj-[A-Za-z0-9_-]+))(?:/|$)", raw)
        return (match.group(1), match.group(2)) if match else ("", "")
'''
        result = patched_windows_identity(source)
        namespace = {"re": re}
        exec(compile(result, '<test>', 'exec'), namespace)
        for path in [r'C:\Users\Alice\service_linggan\agent_jiuwen_lgj-test\agent\workspace', '/home/alice/service_linggan/agent_jiuwen_lgj-test/agent/workspace']:
            self.assertEqual(namespace['identity'](path), ('jiuwen_lgj-test', 'lgj-test'))
        self.assertEqual(namespace['identity']('/unrelated/workspace'), ('', ''))
        self.assertEqual(patched_windows_identity(result), result)

    def test_scoped_arguments_preserve_empty_collections_without_changing_normal_calls(self):
        import sys
        from types import ModuleType
        module_name = 'jiuwenswarm.server.runtime.agent_adapter.interface_deep'
        module = ModuleType(module_name)
        source = 'def format_args(self, kwargs, arguments):\n                skip_none_value = kwargs.get("skip_none_value", True)\n                if skip_none_value:\n                    arguments = SchemaUtils.remove_none_values(arguments) or {}\n                return arguments\n'
        result = patched_scoped_mcp_arguments(source)
        from types import SimpleNamespace
        namespace = {"SchemaUtils": SimpleNamespace(remove_none_values=lambda value: {k: v for k, v in value.items() if v})}
        exec(compile(result, '<test>', 'exec'), namespace)
        with mock_patch.dict(sys.modules, {module_name: module}):
            args = {"evidence": [], "optional": None, "nested": {"items": [], "absent": None}, "false": False, "zero": 0}
            for session in ['ordinary', None, 'ea_collab_test:1']:
                module.get_runtime_tool_session_id = lambda: session
                formatted = namespace['format_args'](SimpleNamespace(_card=SimpleNamespace(name='unrelated_tool')), {}, args)
                if session and session.startswith('ea_collab_'):
                    self.assertEqual(formatted, {"evidence": [], "nested": {"items": []}, "false": False, "zero": 0})
                else:
                    self.assertEqual(formatted, namespace['SchemaUtils'].remove_none_values(args))
            module.get_runtime_tool_session_id = lambda: 'ordinary_chat'
            for name in ['prepare_personal_schedule_write', 'prepare_meeting_invitation']:
                formatted = namespace['format_args'](SimpleNamespace(_card=SimpleNamespace(name=name)), {}, {'participantIds': [], 'optional': None})
                self.assertEqual(formatted, {'participantIds': []})
        self.assertEqual(patched_scoped_mcp_arguments(result), result)
        with self.assertRaises(ValueError):
            patched_scoped_mcp_arguments('unsupported = True\n')

    def test_adapter_scope_is_opt_in_and_carries_fenced_identity(self):
        source = 'class Adapter:\n    def config(cls):\n            agent_id, channel_id = cls._extract_linggan_agent_context_from_workspace(workspace_dir)\n'
        result = patched_adapter(source)
        ast.parse(result)
        self.assertEqual(patched_adapter(result), result)
        self.assertIn('scope_path.is_file()', result)
        for header in ['x-ea-collaboration-capability', 'x-ea-authorization-snapshot-id', 'x-linggan-session-id']:
            self.assertIn(header, result)
        self.assertIn('!= "platform_tools"', result)

    def test_unsupported_layout_fails_before_modification(self):
        for transform in [patched_adapter, patched_auth, patched_windows_cert, patched_windows_identity, patched_mcp_signature, patched_scoped_catalog, patched_hook_executor, patched_hook_rail, patched_runtime_probe]:
            with self.assertRaises(ValueError):
                transform('unsupported = True\n')

    def test_session_is_resolved_per_request_without_mutable_global_headers(self):
        source = 'def auth():\n        query_params = getattr(provider, "query_params", None)\n'
        result = patched_auth(source)
        ast.parse(result)
        self.assertIn('get_runtime_tool_session_id()', result)
        self.assertEqual(patched_auth(result), result)

    def test_windows_hook_uses_argv_without_shell_quoting(self):
        source = 'async def run():\n            proc = await execute(\n                shell, "-c", command,\n            )\n'
        result = patched_hook_executor(source)
        ast.parse(result)
        self.assertIn('config["ea_argv"]', result)
        self.assertIn('os.name == "nt"', result)
        self.assertEqual(patched_hook_executor(result), result)

    def test_certificate_patch_keeps_tls_and_only_accepts_bundled_ca_on_windows(self):
        source = 'class SSL:\n    def _secure_load_cert(ctx, ssl_cert):\n        original_load()\n'
        result = patched_windows_cert(source)
        ast.parse(result)
        self.assertIn('certifi.contents()', result)
        self.assertIn('raise ValueError', result)
        self.assertEqual(patched_windows_cert(result), result)

    def test_scoped_catalog_removes_native_abilities_only_in_isolated_workspace(self):
        source = 'def catalog():\n        for existing in items:\n            if name in _NATIVE_CRON_TOOL_NAMES:\n                remove(name)\n'
        result = patched_scoped_catalog(source)
        ast.parse(result)
        self.assertIn('scoped and not isinstance(existing, McpServerConfig)', result)
        self.assertEqual(patched_scoped_catalog(result), result)

    def test_hook_failure_is_closed_only_for_collaboration(self):
        source = '''async def hook(ctx):
        tool_args = ctx.inputs.tool_args
        for r in results:
            if r.outcome == "blocking":
                pass
        data = {
                "session_id": getattr(ctx, "session_id", ""),
        }
'''
        base = source
        source += base.replace('hook(ctx)', 'post(ctx)').replace('        tool_args = ctx.inputs.tool_args\n', '')
        source += base.replace('hook(ctx)', 'stop(ctx)').replace('        tool_args = ctx.inputs.tool_args\n', '')
        source += 'def other(ctx):\n        return {\n                "session_id": getattr(ctx, "session_id", ""),\n        }\n'
        result = patched_hook_rail(source)
        ast.parse(result)
        self.assertIn('startswith("ea_collab_") and r.outcome != "success"', result)
        self.assertEqual(patched_hook_rail(result), result)

    def test_probe_is_read_only_and_does_not_modify_existing_status_actions(self):
        source = 'def status():\n            if action == "usage":\n                original_usage()\n'
        result = patched_runtime_probe(source)
        ast.parse(result)
        self.assertIn('ea_collaboration_scope_version', result)
        self.assertIn('elif action == "usage":', result)
        self.assertEqual(patched_runtime_probe(result), result)


@unittest.skipUnless(os.getenv('RUN_HOOK_INTEGRATION_TESTS') == '1', 'requires configured local runtime and backend')
class LocalWindowsHookTests(unittest.IsolatedAsyncioTestCase):
    async def test_installed_mcp_formatter_keeps_required_empty_values_and_omits_absent_optionals(self):
        import sys
        from types import ModuleType
        from unittest.mock import AsyncMock
        from openjiuwen.core.foundation.tool.mcp.base import MCPTool, McpToolCard
        from openjiuwen.core.common.utils.schema_utils import SchemaUtils
        schema = {"type": "object", "properties": {
            "evidence": {"type": "array", "items": {"type": "string"}},
            "filters": {"type": "object"}, "enabled": {"type": "boolean"},
            "offset": {"type": "integer"}, "optional": {"type": "string"},
        }, "required": ["evidence", "filters", "enabled", "offset"]}
        inputs = {"evidence": [], "filters": {}, "enabled": False, "offset": 0}
        tool = object.__new__(MCPTool)
        tool._card = McpToolCard(id='argument-regression', name='argument_regression', server_name='local', input_params=schema)
        tool._mcp_client = AsyncMock()
        module_name = 'jiuwenswarm.server.runtime.agent_adapter.interface_deep'
        module = ModuleType(module_name)
        with mock_patch.dict(sys.modules, {module_name: module}):
            for session in ['ordinary', 'ea_collab_regression:1']:
                module.get_runtime_tool_session_id = lambda: session
                await MCPTool.invoke(tool, inputs)
                sent = tool._mcp_client.call_tool.call_args.kwargs['arguments']
                expected = inputs if session.startswith('ea_collab_') else (SchemaUtils.remove_none_values(SchemaUtils.format_with_schema(inputs, schema, skip_none_value=False)) or {})
                self.assertEqual(sent, expected)
                self.assertNotIn('optional', sent)

    async def test_installed_hook_uses_windows_argv_and_preserves_fail_closed_decisions(self):
        import yaml
        from dotenv import dotenv_values
        from jiuwenswarm.common.hooks_config import load_hooks_config
        from jiuwenswarm.server.hooks.executor import HookExecutor
        root = Path(os.environ.get('EA_LOCAL_RUNTIME_ROOT', 'C:/ProgramData/EmployeeAgent/jiuwen-data'))
        config = yaml.safe_load((root / 'config/config.yaml').read_text(encoding='utf-8'))
        hooks = load_hooks_config(config).match('PreToolUse', 'read_file')
        self.assertTrue(hooks)
        if os.name == 'nt':
            self.assertTrue(hooks[0].get('ea_argv'))
        with mock_patch.dict(os.environ, dotenv_values(root / 'config/.env')):
            ordinary = await HookExecutor().run_all(hooks, {'tool_name': 'read_file', 'tool_input': {}, 'session_id': 'local-hook-test'})
            self.assertEqual(ordinary[0].outcome, 'success')
            isolated = await HookExecutor().run_all(hooks, {'tool_name': 'bash', 'tool_input': {'command': 'not executed'}, 'session_id': 'ea_collab_nonexistent:1'})
            self.assertEqual(isolated[0].outcome, 'blocking')


if __name__ == '__main__':
    unittest.main()
