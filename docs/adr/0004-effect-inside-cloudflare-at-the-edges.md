# Effect in the domain, Cloudflare's libraries at the edges

Tool handlers and the domain layer are Effect programs. OAuth and the MCP transport use Cloudflare's own libraries (`@cloudflare/workers-oauth-provider` and `agents`). Effect's own MCP server is marked unstable and would need hand-wired OAuth props and host and origin checks, and that is the part of the system where a mistake is a security hole.
