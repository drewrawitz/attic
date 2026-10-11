# A tool turns away a key it does not declare

A model is the only writer, and Effect's check drops any key a schema does not declare. So a model that sent a room's size beside `data` and not inside it got a save that looked as if it had worked, with the fact gone. Every tool's check is now told to fail on such a key (`onExcessProperty: "error"`). The error names the key and lists the fields there are. The JSON Schema a client is sent says the same thing: `additionalProperties: false` on a tool's input and on any struct inside a field. A record's `data` is a record of any key, so it stays open.

## Considered options

- Keep dropping the key and name it in the reply: no call fails, but the save that lost the fact has already been written, and the model has to read the reply to notice.
- Turn the key away and go on publishing `additionalProperties: true`: nothing a client reads would change. But a client may send whatever the schema allows, and one does. n8n adds keys of its own to a call (`toolCallId`, `sessionId`, `action`, `chatInput`), and since 2.3.5 and 1.123.14 it leaves them out unless the schema says `additionalProperties: true` (n8n issue 21716). Published as open, every call from it would be refused.
- Turn away keys on write tools only: a read loses as much. A `search` with a misspelled `property` would look through every Property and say nothing.

## Consequences

- The check and the JSON Schema are both made in `defineTool` (`packages/core/src/tool.ts`), once, from the same setting (issue 40). The Worker registers what a tool carries, and the tests call the same check, so the two cannot differ.
- Nothing else converts a tool's schema. `Schema.toStandardSchemaV1` keeps the first check it builds on a schema and hands that one back whatever options come later (effect 4.0.2). A second conversion would either be ignored or, if it ran first, put back the check that drops keys.
- `Schema.toStandardJSONSchemaV1` takes no options and publishes a struct as `additionalProperties: true`, so the JSON Schema comes from `Schema.toJsonSchemaDocument` with the same setting as the check. It is made in draft 2020-12 only, the one dialect the MCP SDK asks for.
- A client that adds keys of its own to `arguments`, whatever the schema says, cannot call Attic. That was already so for `get_schema`, which takes nothing and is the first tool a client is told to call. Claude sends none: on 2026-10-11 a call to `get_schema` from Claude Code, through the Attic connector, went through, and the same call with one extra key came back with the Worker's own error. So it neither adds keys nor takes out the ones a model sends. n8n before 2.3.5 and 1.123.14 did add them. Codex, Cursor, and Grok were not tried.
- If a client that does this has to be let in, the narrower fix is to drop that client's keys, by name, before the check. Going back to dropping every key would bring the lost facts back.
- A client may leave out a key the schema does not allow before it sends the call, as n8n now does. Attic never sees that key, so it cannot say anything about it.
- A new tool gets all of this by being declared. A struct inside a field is closed too, so a field that should take any key is a `Schema.Record`.
