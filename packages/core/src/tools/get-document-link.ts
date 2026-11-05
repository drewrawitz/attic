import { Effect, Schema } from "effect";
import { documentPath, documentToOpen } from "../document.ts";
import { SignedAddresses, SIGNED_FOR_MINUTES } from "../signed-address.ts";
import { defineTool, noRecord } from "../tool.ts";

const DESCRIPTION = `Returns a link the User taps to open a Document's file: the photo, the Receipt, the quote, the manual, or the warranty itself. Attic never sends a file to a client, so this is how the User sees one again.

Give the Document's id, as get_record and search give it. The link works for ${SIGNED_FOR_MINUTES} minutes. It comes back with the Document's title, kind, type, and size, so you can say what the link opens.`;

// What the client is to do with the link.
const NEXT = `Give the User this link, and say what it opens. It works for ${SIGNED_FOR_MINUTES} minutes.`;

export const getDocumentLink = defineTool({
  name: "get_document_link",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: Schema.String.annotate({
      description: "The Document's id, as get_record and search give it.",
    }),
  }),
  // It signs a link and keeps nothing, so it writes nothing.
  annotations: { readOnlyHint: true },
  run: ({ id }) =>
    Effect.gen(function* () {
      const document = yield* documentToOpen(id);
      if (document === undefined) return yield* noRecord("document", id);
      const { address, until } = yield* (yield* SignedAddresses).sign(documentPath(id));
      return {
        link: address,
        until: new Date(until).toISOString(),
        next: NEXT,
        title: document.title,
        kind: document.kind,
        mime_type: document.mime_type,
        size_bytes: document.size_bytes,
      };
    }),
});
