# Hermes Profile A2A Runtime

Authenticated A2A adapter for EA-managed Hermes expert profiles.

The profile is a long-lived expert template. Each EA conversation context gets
its own workspace and Hermes session, while every turn runs in a fresh child
process. The adapter serializes turns in one context, allows bounded concurrency
across contexts, supports `tasks/cancel`, and removes inactive workspaces after
the configured TTL.

Supported workspace modes:

- `ppt`: prepares the CyberPPT workspace and Linux merge verifier.
- `diagram`: prepares the Archify workspace.
- `generic`: creates only the isolated context workspace.

Runtime secrets belong in a deployment-owned `.env` file with mode `0600`; do
not commit profile tokens or download signing secrets. Existing PPT and diagram
deployments remain compatible with `A2A_REQUIRE_PPT_TOOLS` when
`A2A_WORKSPACE_KIND` is not set.

Run tests:

```bash
python3 -m unittest discover -s server/agents/hermes-profile-a2a/tests -p 'test_*.py'
```
