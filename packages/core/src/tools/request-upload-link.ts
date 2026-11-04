import { Effect, Schema } from "effect";
import { partialDate } from "../dates.ts";
import {
  ATTACHABLE,
  attachedToNow,
  keepUploadRequest,
  KINDS,
  MOST_FILE_MEGABYTES,
  uploadPath,
  type UploadRequest,
} from "../document.ts";
import { amount, inCents } from "../money.ts";
import { orAtNoProperty, propertyFor } from "../property.ts";
import { MOST_IN_ONE_CALL, nameText, SAVE_ANNOTATIONS } from "../save.ts";
import { SignedAddresses, SIGNED_FOR_MINUTES } from "../signed-address.ts";
import { defineTool, noRecord, optional, ToolError } from "../tool.ts";
import { Ids } from "../write.ts";

const DESCRIPTION = `Returns a link the User taps to put a file in Attic as a Document: a photo, a Receipt, a quote, a manual, or a warranty. A Receipt is any proof of what was paid, so an invoice or an order confirmation is a Receipt.

A client cannot hand Attic a file it was shown. So when the User shows you one, read it, save what it says to the records it is about first (the Item, the Work, the Vendor), and then call this with what you read and the records to attach it to. Give the User the link that comes back, and say what it is for. They tap it and pick the same file again, or several files: each one becomes a Document of its own, with the details given here. A client that can run commands posts the file to the link itself, as the page does: the bytes as the body, with its type in \`content-type\` and its SHA-256 in hex in \`x-content-sha256\`. Images and PDFs only, up to ${MOST_FILE_MEGABYTES} MB each.

The link works for ${SIGNED_FOR_MINUTES} minutes. Nothing is saved until a file arrives: the Document is made then, as one Change, and a Vendor that is not there yet is made with it. The same file sent twice is stored once, and its Document is attached to the records of both.

\`attach_to\` names each record by its type and id, as search and get_record give them, and each one has to be there. A Document is at the Property given, or at the one Current property. When there is not exactly one Current property, a Document attached to a record is at no Property, and one attached to nothing has to say which.

What comes back is the link, when it runs out, the Property, and what the Document will be attached to, by name.`;

const ATTACHED_TO = Schema.Struct({
  type: Schema.Literals(ATTACHABLE).annotate({ description: "What kind of record it is." }),
  id: Schema.String.annotate({ description: "The record's id, as search or get_record gives it." }),
});

// What the client is to do with the link.
const NEXT = `Give the User this link. They tap it and pick the file again, or several files. It works for ${SIGNED_FOR_MINUTES} minutes.`;

export const requestUploadLink = defineTool({
  name: "request_upload_link",
  description: DESCRIPTION,
  input: Schema.Struct({
    title: nameText(
      'What the Document is, as the User would look for it, such as "Dishwasher order confirmation".',
    ),
    kind: Schema.Literals(KINDS).annotate({
      description:
        "What kind of Document it is. A Receipt is any proof of what was paid: a store receipt, an invoice, or an order confirmation.",
    }),
    date: optional(
      partialDate("The date on the Document itself, such as the day of the order, not today."),
    ),
    total: optional(amount("The total the Document shows.")),
    vendor: optional(
      nameText(
        "The Vendor the Document is from, by name, matched whatever its case. One that is not there yet is made when the file arrives.",
      ),
    ),
    text: optional(
      Schema.String.annotate({
        description:
          "What the file says, as you read it: the lines worth finding it by later, such as the store, the items, their part numbers, and the order number. search finds the Document by this.",
      }),
    ),
    attach_to: optional(
      Schema.Array(ATTACHED_TO)
        .annotate({
          description: `The records the Document is about, up to ${MOST_IN_ONE_CALL}: the Item a Receipt is for, the Work an invoice is for, the Vendor it is from. Leave it out for a Document that is about nothing in Attic yet.`,
        })
        .check(
          Schema.isMaxLength(MOST_IN_ONE_CALL, {
            message: `Expected at most ${MOST_IN_ONE_CALL} records to attach the Document to.`,
          }),
        ),
    ),
    property: optional(
      nameText(
        "The Property the Document is at, by its id or its name. Leave it out for the one Current property.",
      ),
    ),
  }),
  // It keeps the request until the link runs out, and writes no record.
  annotations: SAVE_ANNOTATIONS,
  run: ({ title, kind, date, total, vendor, text, attach_to = [], property: given }) =>
    Effect.gen(function* () {
      const attached = yield* attachedToNow(attach_to);
      const missing = attached.filter(({ name }) => name === null);
      if (missing.length > 0) {
        return yield* new ToolError({
          message: missing.map(({ type, id }) => noRecord(type, id).message).join(" "),
        });
      }

      // With not exactly one Current property, a Document on a record is at no Property, as
      // Work on Items is.
      const property = yield* orAtNoProperty(propertyFor(given), given, attached.length > 0);

      const request: UploadRequest = {
        title,
        kind,
        ...(date === undefined ? {} : { doc_date: date }),
        ...(total === undefined ? {} : { total_cents: inCents(total) }),
        ...(vendor === undefined ? {} : { vendor }),
        ...(text === undefined ? {} : { text }),
        attach_to: attached.map(({ type, id }) => ({ type, id })),
        property_id: property?.id ?? null,
      };
      const requestId = yield* (yield* Ids).next;
      const { address, until } = yield* (yield* SignedAddresses).sign(uploadPath(requestId));
      yield* keepUploadRequest(requestId, request, until);

      return {
        link: address,
        until: new Date(until).toISOString(),
        next: NEXT,
        property,
        attach_to: attached,
      };
    }),
});
