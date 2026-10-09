# Files go in through a short-lived upload link

An MCP client can show the model a file but cannot hand the raw bytes to a server, and base64 in tool arguments does not survive real photo sizes. So a tool returns a signed link that lasts 15 minutes. A person opens it and picks files on a bare page served by the Worker, and a client with a shell posts the file to the same link. The Document is created when the bytes arrive, carrying the kind, date, total, text, and links the model supplied when it asked for the link.

## Consequences

- In a chat client the User handles a file twice: once to show the model, once to upload.
- Files are never sent back to the model. Some clients cap tool results too small for a photo (about 150,000 characters in claude.ai), and not every client passes images through. Viewing a file is a short-lived link the User opens.
- Reading the text out of a file on the server would remove the double handling. It is deferred because it adds an AI dependency.
