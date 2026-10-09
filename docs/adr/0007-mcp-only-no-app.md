# MCP only, no app

Attic has no app UI. It is a remote MCP server, and the User's own AI clients are the interface. Any client that speaks MCP should work, so tools never depend on client extras such as prompts, images in tool results, or scheduled tasks.

Three small things live outside MCP on purpose: the sign-in consent page, a bare file upload page (see ADR 0008), and an optional weekly email digest of what is due. None of them is a place to browse or edit records. Richer views can come later as MCP Apps.
