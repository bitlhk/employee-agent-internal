"""Add optional EA collaboration scope propagation to pinned JiuwenSwarm ea.13.

No global permissions are changed. Unsupported source layouts fail before writes.
"""
from __future__ import annotations
import argparse
import ast
from pathlib import Path

MARKER = "# EA_COLLABORATION_SCOPE_V1"

def patched_windows_identity(source: str) -> str:
    marker = "# EA_WINDOWS_MCP_IDENTITY_V1"
    if marker in source:
        return source
    anchor = '        raw = str(workspace_dir or "").strip()\n'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported JiuwenSwarm workspace identity parser")
    return source.replace(anchor, '        # EA_WINDOWS_MCP_IDENTITY_V1\n' +
                          '        raw = str(workspace_dir or "").strip().replace("\\\\", "/")\n')

def patched_mcp_signature(source: str) -> str:
    marker = "# EA_MCP_DYNAMIC_TOKEN_SIGNATURE_V1"
    if marker in source:
        return source
    anchor = '        for server_name in to_check:\n'
    current = 'getattr(current_cfg, "auth_headers", None)'
    desired = 'getattr(desired_cfg, "auth_headers", None)'
    if source.count(anchor) != 1 or source.count(current) != 1 or source.count(desired) != 1:
        raise ValueError("Unsupported JiuwenSwarm MCP signature comparison")
    helper = '''        # EA_MCP_DYNAMIC_TOKEN_SIGNATURE_V1
        # Tokens rotate per HTTP request. Their random jti must not disconnect
        # healthy MCP sessions; all identity and capability headers still compare.
        def ea_stable_auth_headers(cfg):
            headers = copy.deepcopy(getattr(cfg, "auth_headers", None))
            if isinstance(headers, dict) and headers.get(EA_RUNTIME_AUDIENCE_HEADER) in EA_INTERNAL_MCP_AUDIENCES.values():
                headers.pop("authorization", None)
            return headers

'''
    return source.replace(anchor, helper + anchor).replace(current, 'ea_stable_auth_headers(current_cfg)').replace(desired, 'ea_stable_auth_headers(desired_cfg)')

def patched_adapter(source: str) -> str:
    if MARKER in source:
        line = '                normalized_headers["x-linggan-session-id"] = scope["sessionId"]\n'
        auth = '                normalized_headers["x-ea-authorization-snapshot-id"] = scope.get("authorizationSnapshotId") or ""\n'
        if auth not in source:
            if source.count(line) != 1:
                raise ValueError("Existing collaboration patch is incomplete")
            return source.replace(line, line + auth)
        return source
    anchor = "            agent_id, channel_id = cls._extract_linggan_agent_context_from_workspace(workspace_dir)\n"
    if source.count(anchor) != 1:
        raise ValueError("Unsupported JiuwenSwarm MCP identity adapter; expected ea.13 anchor")
    addition = '''            # EA_COLLABORATION_SCOPE_V1
            scope_path = Path(str(workspace_dir or "")) / ".linggan-collaboration-scope.json"
            if scope_path.is_file():
                scope = json.loads(scope_path.read_text(encoding="utf-8"))
                if scope.get("version") != 1 or not scope.get("capability"):
                    raise RuntimeError("Invalid EA collaboration scope")
                if str(resolved_entry.get("name") or "") != "platform_tools":
                    return None
                agent_id, channel_id = scope["agentId"], scope["adoptId"]
                normalized_headers["x-ea-collaboration-run-id"] = scope["runId"]
                normalized_headers["x-ea-collaboration-capability"] = scope["capability"]
                normalized_headers["x-linggan-session-id"] = scope["sessionId"]
                normalized_headers["x-ea-authorization-snapshot-id"] = scope.get("authorizationSnapshotId") or ""
'''
    return source.replace(anchor, anchor + addition)

def patched_auth(source: str) -> str:
    marker = "# EA_MCP_REQUEST_SESSION_V2"
    if marker in source:
        return source
    old = '''        # EA_COLLABORATION_SCOPE_V1
        # ContextVar is evaluated per request; no cross-session mutable header.
        from jiuwenswarm.server.runtime.agent_adapter.interface_deep import get_runtime_tool_session_id
        session_id = get_runtime_tool_session_id()
        if session_id:
            request.headers["x-linggan-session-id"] = session_id
'''
    if MARKER in source:
        if source.count(old) != 1:
            raise ValueError("Unsupported previous per-request session adapter")
        source = source.replace(old, "")
    anchor = '        query_params = getattr(provider, "query_params", None)\n'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported JiuwenSwarm request auth flow")
    addition = '''        # EA_MCP_REQUEST_SESSION_V2
        # The HTTP transport runs in its own task. Metadata carries the actual
        # caller's session without mutating a shared connection's headers.
        from jiuwenswarm.server.runtime.agent_adapter.interface_deep import get_runtime_tool_session_id
        from jiuwenswarm.server.runtime.ea_conversation_context import mcp_request_session_id
        session_id = mcp_request_session_id(request, get_runtime_tool_session_id())
        if session_id:
            request.headers["x-linggan-session-id"] = session_id
'''
    return source.replace(anchor, addition + anchor)


def patched_mcp_session_metadata(source: str) -> str:
    marker = "# EA_MCP_REQUEST_SESSION_V1"
    if marker in source:
        return source
    anchor = '            tool_result = await self._session.call_tool(tool_name, arguments=arguments)\n'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported MCP per-call metadata adapter")
    return source.replace(anchor, '''            # EA_MCP_REQUEST_SESSION_V1
            from jiuwenswarm.server.runtime.agent_adapter.interface_deep import get_runtime_tool_session_id
            ea_session_id = get_runtime_tool_session_id()
            tool_result = await self._session.call_tool(tool_name, arguments=arguments,
                meta={"ea_session_id": ea_session_id} if ea_session_id else None)
''')


def patched_windows_cert(source: str) -> str:
    marker = "# EA_WINDOWS_BUNDLED_CA_V1"
    if marker in source:
        return source
    anchor = "    def _secure_load_cert(ctx, ssl_cert):\n"
    if source.count(anchor) != 1:
        raise ValueError("Unsupported openJiuwen certificate loader")
    # Windows lacks O_NOFOLLOW. Permit only the runtime's bundled CA here;
    # arbitrary paths remain rejected rather than weakening certificate checks.
    addition = '''        # EA_WINDOWS_BUNDLED_CA_V1
        if os.name == "nt":
            import certifi
            if os.path.normcase(os.path.realpath(ssl_cert)) != os.path.normcase(os.path.realpath(certifi.where())):
                raise ValueError("Windows runtime requires its bundled CA certificate")
            ctx.load_verify_locations(cadata=certifi.contents())
            return
'''
    return source.replace(anchor, anchor + addition)


def patched_scoped_catalog(source: str) -> str:
    marker = "# EA_COLLABORATION_NATIVE_DENY_V1"
    if marker in source:
        return source
    anchor = "            if name in _NATIVE_CRON_TOOL_NAMES:\n"
    if source.count(anchor) != 1:
        raise ValueError("Unsupported native ability catalog")
    return source.replace(anchor, '''            # EA_COLLABORATION_NATIVE_DENY_V1
            scoped = (Path(str(self._workspace_dir or "")) / ".linggan-collaboration-scope.json").is_file()
            if name in _NATIVE_CRON_TOOL_NAMES or (scoped and not isinstance(existing, McpServerConfig)):
''')


def patched_hook_executor(source: str) -> str:
    marker = "# EA_WINDOWS_HOOK_ARGV_V1"
    if marker in source:
        return source
    anchor = '                shell, "-c", command,\n'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported hook subprocess executor")
    return source.replace(anchor, '''                # EA_WINDOWS_HOOK_ARGV_V1
                *(config["ea_argv"] if os.name == "nt" and config.get("ea_argv") else [shell, "-c", command]),
''')


def patched_hook_rail(source: str) -> str:
    marker = "# EA_COLLABORATION_HOOK_FAIL_CLOSED_V1"
    if marker in source:
        return source
    anchor = '        tool_args = ctx.inputs.tool_args\n'
    session = '                "session_id": getattr(ctx, "session_id", ""),\n'
    outcome = '            if r.outcome == "blocking":\n'
    if source.count(anchor) != 1 or source.count(outcome) != 3 or source.count(session) != 4:
        raise ValueError("Unsupported hook rail")
    source = source.replace(anchor, anchor + '''        # EA_COLLABORATION_HOOK_FAIL_CLOSED_V1
        from jiuwenswarm.server.runtime.agent_adapter.interface_deep import get_runtime_tool_session_id
        runtime_session = get_runtime_tool_session_id() or getattr(ctx, "session_id", "")
''')
    source = source.replace(session, '                "session_id": runtime_session,\n', 1)
    return source.replace(outcome, '            if r.outcome == "blocking" or (str(runtime_session).startswith("ea_collab_") and r.outcome != "success"):\n', 1)


def patched_runtime_probe(source: str) -> str:
    marker = "# EA_COLLABORATION_PROBE_V1"
    if marker in source:
        return source.replace('payload={"ea_collaboration_scope_version": 1}', 'payload={"ea_collaboration_scope_version": 1, "ea_conversation_context_version": 1}')
    anchor = '            if action == "usage":\n'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported AgentServer status handler")
    return source.replace(anchor, '''            # EA_COLLABORATION_PROBE_V1
            if action == "ea-collaboration":
                resp = AgentResponse(
                    request_id=request.request_id,
                    channel_id=request.channel_id,
                    ok=True,
                    payload={"ea_collaboration_scope_version": 1, "ea_conversation_context_version": 1},
                )
            elif action == "usage":
''')

def patched_scoped_mcp_arguments(source: str) -> str:
    marker = "# EA_COLLABORATION_MCP_ARGUMENTS_V3"
    if marker in source:
        return source
    scope = '                ea_scoped_arguments = str(get_runtime_tool_session_id() or "").startswith("ea_collab_")\n'
    calendar_scope = scope + '''                # Ordinary chat can explicitly remove all participants with [].
                ea_calendar_write = self._card.name in {"prepare_personal_schedule_write", "prepare_meeting_invitation"}
                ea_scoped_arguments = ea_scoped_arguments or ea_calendar_write
'''
    if "# EA_COLLABORATION_MCP_ARGUMENTS_V2" in source:
        if source.count(scope) != 1:
            raise ValueError("Unsupported previous MCP argument scope")
        return source.replace("# EA_COLLABORATION_MCP_ARGUMENTS_V2", marker).replace(scope, calendar_scope)
    old = '''                # EA_COLLABORATION_MCP_ARGUMENTS_V1
                # Upstream remove_none_values also removes valid []/{} values.
                # Preserve schema-validated inputs only in isolated EA turns.
                from jiuwenswarm.server.runtime.agent_adapter.interface_deep import get_runtime_tool_session_id
                if str(get_runtime_tool_session_id() or "").startswith("ea_collab_"):
                    skip_none_value = False
'''
    if "# EA_COLLABORATION_MCP_ARGUMENTS_V1" in source:
        if source.count(old) != 1:
            raise ValueError("Unsupported previous MCP argument patch")
        source = source.replace(old, "")
    anchor = '                skip_none_value = kwargs.get("skip_none_value", True)\n'
    remove = '                    arguments = SchemaUtils.remove_none_values(arguments) or {}\n'
    if source.count(anchor) != 1 or source.count(remove) != 1:
        raise ValueError("Unsupported MCP argument formatter")
    source = source.replace(anchor, anchor + '''                # EA_COLLABORATION_MCP_ARGUMENTS_V3
                # Upstream remove_none_values also removes valid []/{} values.
                # Schema formatting adds absent optional properties as None:
                # remove those, but retain meaningful empty collections/false/0.
                from jiuwenswarm.server.runtime.agent_adapter.interface_deep import get_runtime_tool_session_id
                ea_scoped_arguments = str(get_runtime_tool_session_id() or "").startswith("ea_collab_")
''')
    source = source.replace(scope, calendar_scope)
    return source.replace(remove, '''                    if ea_scoped_arguments:
                        def ea_without_null(value):
                            if isinstance(value, dict):
                                return {k: ea_without_null(v) for k, v in value.items() if v is not None}
                            if isinstance(value, list):
                                return [ea_without_null(v) for v in value if v is not None]
                            return value
                        arguments = ea_without_null(arguments)
                    else:
                        arguments = SchemaUtils.remove_none_values(arguments) or {}
''')


def patched_conversation_delivery(source: str) -> str:
    marker = "# EA_CONVERSATION_CONTEXT_V1"
    if marker in source:
        return source
    anchor = '            elif action == "usage":\n'
    if source.count(anchor) != 1:
        raise ValueError("Unsupported conversation status adapter")
    return source.replace(anchor, '''            # EA_CONVERSATION_CONTEXT_V1
            elif action == "ea-conversation-append":
                from jiuwenswarm.server.runtime.ea_conversation_context import append_signed_context
                result = append_signed_context(params)
                resp = AgentResponse(request_id=request.request_id, channel_id=request.channel_id,
                                     ok=True, payload=result)
            elif action == "usage":
''')


def patched_conversation_inputs(source: str) -> str:
    marker = "# EA_CONVERSATION_INPUTS_V1"
    if marker in source:
        return source
    anchor = '            inputs = self._prepare_multimodal_image_inputs(\n'
    if source.count(anchor) != 2:
        raise ValueError("Unsupported runtime turn context adapter")
    return source.replace(anchor, '''            # EA_CONVERSATION_INPUTS_V1
            from jiuwenswarm.server.runtime.ea_conversation_context import with_conversation_context
            inputs = with_conversation_context(inputs, session_id)
''' + anchor)


def patch(root: Path) -> list[str]:
    files = {
        root / "jiuwenswarm/server/runtime/agent_adapter/interface_deep.py": lambda source: patched_conversation_inputs(patched_mcp_signature(patched_windows_identity(patched_scoped_catalog(patched_adapter(source))))),
        root / "jiuwenswarm/common/ea_runtime_token.py": patched_auth,
        root / "openjiuwen/core/foundation/tool/mcp/client/streamable_http_client.py": patched_mcp_session_metadata,
        root / "jiuwenswarm/server/hooks/executor.py": patched_hook_executor,
        root / "jiuwenswarm/server/hooks/user_hook_rail.py": patched_hook_rail,
        root / "jiuwenswarm/server/agent_ws_server.py": lambda source: patched_conversation_delivery(patched_runtime_probe(source)),
    }
    certificate_loader = root / "openjiuwen/core/common/security/ssl_utils.py"
    if certificate_loader.is_file():
        files[certificate_loader] = patched_windows_cert
    files[root / "openjiuwen/core/foundation/tool/mcp/base.py"] = patched_scoped_mcp_arguments
    output = []
    for file, transform in files.items():
        source = file.read_text(encoding="utf-8")
        result = transform(source)
        ast.parse(result, filename=str(file))
        output.append((file, result))
    helper = Path(__file__).with_name("jiuwen_conversation_context.py").read_text(encoding="utf-8")
    ast.parse(helper)
    output.append((root / "jiuwenswarm/server/runtime/ea_conversation_context.py", helper))
    for file, result in output:
        file.write_text(result, encoding="utf-8")
    return [str(file) for file, _ in output]

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print("\n".join(patch(args.root.resolve())))
