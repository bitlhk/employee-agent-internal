# Business Tools

Business tools are environment-specific MCP services that expose enterprise data
or domain actions to the agent runtime.

This repository intentionally does not ship production business MCP source code.
In deployed environments, business tools are installed and operated outside the
EA source tree, commonly under a runtime MCP directory such as `~/.openclaw/mcp`.

JiuwenSwarm discovers usable tools from its active `mcp.servers`
configuration. EA manages role grants, audit, status display, and platform
integration; it does not auto-load business tool source files from this
directory.

Use `examples/mcp/hello-business-tool` as a minimal reference for implementing
your own streamable HTTP MCP business tool.
