import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { checkSignature } from "../../src/signed-address.ts";
import { noRecord } from "../../src/tool.ts";
import { getDocumentLink } from "../../src/tools/get-document-link.ts";
import { requestUploadLink } from "../../src/tools/request-upload-link.ts";
import { answer, call, callAsClient, TEST_ORIGIN, TEST_SECRET, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

const linking = (input: unknown) => callAsClient(getDocumentLink, input).pipe(Effect.map(answer));

// The made-up household's Documents have no file behind them, which this tool never looks at.
const TODAY = "2026-10-11";
const NOON = Date.parse(`${TODAY}T12:00:00Z`);
const FAUCET_RECEIPT = "seed-doc-faucet-receipt";

// The same query on another path: what a link that was made for one thing is at another.
const movedTo = (link: string, path: string) => {
  const moved = new URL(link);
  moved.pathname = path;
  return moved;
};

const changesCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counted] = yield* sql<{ changes: number }>`SELECT count(*) AS changes FROM changes`;
  return counted!.changes;
});

it.effect(
  "get_document_link signs a link to a Document's file for 15 minutes, and writes nothing",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      const before = yield* changesCount;

      const linked = yield* linking({ id: FAUCET_RECEIPT });

      expect(linked).toEqual({
        link: expect.stringMatching(
          new RegExp(`^${TEST_ORIGIN}/document/${FAUCET_RECEIPT}\\?until=\\d+&signature=`),
        ),
        until: "2026-10-11T12:15:00.000Z",
        next: expect.stringContaining("15 minutes"),
        title: "Pipewise invoice 1187",
        kind: "receipt",
        mime_type: "application/pdf",
        size_bytes: null,
      });
      const link = new URL(linked.link as string);
      expect(yield* Effect.promise(() => checkSignature(TEST_SECRET, link, NOON))).toBe("signed");
      expect(yield* changesCount).toBe(before);
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a link to a Document's file and an upload link cannot stand in for each other", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const documentLink = (yield* linking({ id: FAUCET_RECEIPT })).link as string;
    const uploadLink = (yield* callAsClient(requestUploadLink, {
      title: "Faucet photo",
      kind: "photo",
    }).pipe(Effect.map(answer))).link as string;
    const checked = (address: URL) =>
      Effect.promise(() => checkSignature(TEST_SECRET, address, NOON));

    expect(yield* checked(movedTo(documentLink, `/upload/${FAUCET_RECEIPT}`))).toBe("not signed");
    const requestId = new URL(uploadLink).pathname.split("/").at(-1)!;
    expect(yield* checked(movedTo(uploadLink, `/document/${requestId}`))).toBe("not signed");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("get_document_link refuses a Document that is not there", () =>
  Effect.gen(function* () {
    yield* loadHousehold;

    const refused = yield* call(getDocumentLink, { id: "no-such-document" }).pipe(
      Effect.map(answer),
    );

    expect(refused).toEqual({ refused: noRecord("document", "no-such-document").message });
  }).pipe(Effect.provide(TestDatabase)),
);
