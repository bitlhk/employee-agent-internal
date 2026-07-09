# Hello Business Tool MCP

Minimal streamable HTTP MCP example for implementing a business tool outside
the EA source tree.

Run:

```bash
node server.mjs
```

JiuwenSwarm MCP config example:

```yaml
mcp:
  servers:
    - name: hello_business_tool
      enabled: true
      transport: streamable-http
      url: http://127.0.0.1:17999/mcp
      timeout_s: 30
```

