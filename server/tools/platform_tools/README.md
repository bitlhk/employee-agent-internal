# Platform Tools MCP

`platform_tools` is the EA platform-control MCP server.

The active implementation is embedded in EA at:

- `server/_core/platform-tools-mcp.ts`
- HTTP endpoint: `/api/internal/platform-tools/mcp`

It lets the agent runtime call EA platform capabilities:

- create scheduled tasks
- send notifications
- inspect user channels
- list available external Agents
- submit asynchronous external Agent tasks

This MCP server is not a business data tool and is not an external Agent itself.

Do not run a separate stdio platform-tools server unless you intentionally need
legacy runtime compatibility. The old standalone stdio implementation has been
removed from this source tree to keep the platform control path single-sourced.
