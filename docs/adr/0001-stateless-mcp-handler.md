# Stateless MCP handler instead of McpAgent

Attic's MCP endpoint is the stateless `createMcpHandler` from the `agents` package. It builds a fresh MCP server for each request and uses no Durable Object. `McpAgent` is deprecated and feature-frozen as of `agents` 0.28, and every Attic tool is plain request and response, so there is no session state worth a Durable Object.

Revisit this only if a tool needs the server to hold state between calls.
