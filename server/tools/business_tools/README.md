# Business Tools

Business tools are MCP implementations or adapters that expose domain data and domain actions to the agent runtime.

The source tree is maintained as the deployable/reference source for EA-managed
business MCP services. Runtime availability is decided by the active
JiuwenSwarm MCP configuration and the corresponding PM2/systemd process, not by
directory presence alone.

Current groups:

- `finance`: wealth assistant, Wind bridge, bond quote adapter
- `risk`: post-loan risk data MCP
- `credential`: credential image workspace adapter
- `insurance`: insurance knowledge base and group-insurance adapters

Runtime deployment can still point to existing PM2 processes while the source lives here. Deployment configs should use environment variables or `.env.example` files and must not commit real credentials.

See `catalog.json` for the current active/disabled tool inventory. Disabled
or external-only integrations are not kept in the active source tree unless
they are required as local adapters.
