import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { uploadPath, type ArrivedFile } from "../../src/document.ts";
import { checkSignature } from "../../src/signed-address.ts";
import { ToolError, type ToolServices } from "../../src/tool.ts";
import { deleteRecord } from "../../src/tools/delete-record.ts";
import { getRecord } from "../../src/tools/get-record.ts";
import { receiveFile, requestUploadLink } from "../../src/tools/request-upload-link.ts";
import { saveItem } from "../../src/tools/save-item.ts";
import { saveProperty } from "../../src/tools/save-property.ts";
import { search } from "../../src/tools/search.ts";
import { undo } from "../../src/tools/undo.ts";
import { answer, call, callAsClient, TEST_ORIGIN, TEST_SECRET, todayIs } from "../call.ts";
import { loadHousehold } from "../household.ts";
import { TestDatabase } from "../TestDatabase.ts";

const requesting = (input: unknown) =>
  callAsClient(requestUploadLink, input).pipe(Effect.map(answer));

const getting = (type: string, id: string) =>
  call(getRecord, { type, id }).pipe(Effect.map(answer));

const undoing = (changeId: string) => call(undo, { change_id: changeId }).pipe(Effect.map(answer));

// The made-up household has one Current property on this day: the Maple Street house.
const TODAY = "2026-10-11";
const NOON = Date.parse(`${TODAY}T12:00:00Z`);
const MAPLE = { id: "seed-property-maple", name: "Maple Street house" };
const FRIDGE = { type: "item", id: "seed-item-fridge" } as const;
const HEARTH = { type: "vendor", id: "seed-vendor-hearth" } as const;

// A file as the page sends it.
const PNG: ArrivedFile = { sha256: "a".repeat(64), mimeType: "image/png", size: 2048 };

// The request id in a link, which is the last part of its path.
const requestIn = (link: string) => new URL(link).pathname.split("/").at(-1)!;

// A file arriving for a request, on the database the test runs on. `stored` gets each key the
// bucket is asked to store, and `refusing` makes the bucket say no.
const arriving = (link: string, file: ArrivedFile = PNG, refusing?: string) =>
  Effect.gen(function* () {
    const stored: string[] = [];
    const store = (key: string) =>
      refusing === undefined
        ? Effect.sync(() => void stored.push(key))
        : Effect.fail(new ToolError({ message: refusing }));
    const services = yield* Effect.context<ToolServices>();
    const arrival = yield* receiveFile(
      requestIn(link),
      file,
      store,
      Layer.succeedContext(services),
    );
    return { arrival, stored };
  });

const counting = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ documents: number; requests: number; changes: number }>`
    SELECT (SELECT count(*) FROM documents) AS documents,
           (SELECT count(*) FROM upload_requests) AS requests,
           (SELECT count(*) FROM changes) AS changes`;
  return counts!;
});

const RECEIPT = {
  title: "Fridge water filter order",
  kind: "receipt",
  date: "2026-10-04",
  total: 49.99,
  vendor: "Corner Hardware",
  text: "Order 1182. Water filter, part DA29-00020B.",
  attach_to: [FRIDGE],
};

it.effect(
  "request_upload_link signs a link for 15 minutes, and keeps the request, not a record",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      const before = yield* counting;

      const asked = yield* requesting(RECEIPT);

      expect(asked).toEqual({
        link: expect.stringMatching(new RegExp(`^${TEST_ORIGIN}/upload/id-0001\\?until=`)),
        until: "2026-10-11T12:15:00.000Z",
        next: expect.stringContaining("15 minutes"),
        property: MAPLE,
        attach_to: [{ ...FRIDGE, name: "Fridge" }],
      });
      const link = new URL(asked.link as string);
      expect(yield* Effect.promise(() => checkSignature(TEST_SECRET, link, NOON))).toBe("signed");
      expect(yield* counting).toEqual({ ...before, requests: before.requests + 1 });
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a signature holds for its own path, for 15 minutes", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const link = new URL((yield* requesting(RECEIPT)).link as string);
    const check = (address: URL, at: number) =>
      Effect.promise(() => checkSignature(TEST_SECRET, address, at));

    expect(yield* check(link, NOON + 15 * 60 * 1000 - 1)).toBe("signed");
    expect(yield* check(link, NOON + 15 * 60 * 1000)).toBe("ran out");

    const elsewhere = new URL(link);
    elsewhere.pathname = uploadPath("id-9999");
    expect(yield* check(elsewhere, NOON)).toBe("not signed");
    const later = new URL(link);
    later.searchParams.set("until", String(NOON + 60 * 60 * 1000));
    expect(yield* check(later, NOON)).toBe("not signed");
    expect(yield* Effect.promise(() => checkSignature("another key", link, NOON))).toBe(
      "not signed",
    );
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("request_upload_link refuses a record that is not there, and keeps nothing", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;

    const asked = yield* requesting({
      ...RECEIPT,
      attach_to: [FRIDGE, { type: "work", id: "no-such-work" }],
    });

    expect(asked.refused).toContain('There is no Work with the id "no-such-work".');
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("request_upload_link turns away what it does not take, by name", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const refused = (input: Record<string, unknown>) =>
      Effect.map(requesting({ ...RECEIPT, ...input }), ({ refused }) => refused);

    expect(yield* refused({ notes: "a field it does not have" })).toContain("notes");
    expect(yield* refused({ date: "2026-13" })).toContain("Expected a date that exists");
    expect(yield* refused({ total: -1 })).toContain("not below zero");
    expect(yield* refused({ kind: "invoice" })).toContain("receipt");
    expect(yield* refused({ attach_to: [{ type: "note", id: "x" }] })).toContain("attach_to");
    expect(yield* refused({ title: "  " })).toContain("Expected a name");
  }).pipe(Effect.provide(TestDatabase)),
);

// Before the Elm Court apartment ended, both Properties were current.
it.effect("with not exactly one Current property, a Document on a record is at no Property", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs("2021-06-01");

    expect((yield* requesting(RECEIPT)).property).toBeNull();
    const alone = yield* requesting({ ...RECEIPT, attach_to: [] });
    expect(alone.refused).toContain("Properties are current");
    expect(
      (yield* requesting({ ...RECEIPT, attach_to: [], property: "Maple Street house" })).property,
    ).toEqual(MAPLE);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("asking for a link lets go of the requests that have run out", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    yield* requesting(RECEIPT);
    yield* requesting(RECEIPT);
    yield* TestClock.adjust("16 minutes");

    yield* requesting(RECEIPT);

    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT id FROM upload_requests`).toEqual([{ id: "id-0003" }]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a file that arrives is stored under its Document's id, and written in one Change", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const { link } = yield* requesting(RECEIPT);

    const { arrival, stored } = yield* arriving(link as string);

    // The request is id-0001. Then come the Document, the new Vendor, and the Change.
    expect(arrival).toEqual({ ok: true, document_id: "id-0002", change_id: "id-0004" });
    expect(stored).toEqual(["id-0002"]);
    const document = yield* getting("document", "id-0002");
    expect(document).toEqual(
      expect.objectContaining({
        id: "id-0002",
        kind: "receipt",
        status: "filed",
        title: "Fridge water filter order",
        doc_date: "2026-10-04",
        total: 49.99,
        property: "Maple Street house",
        vendor: "Corner Hardware",
        source: "upload",
        mime_type: "image/png",
        size_bytes: 2048,
        text: "Order 1182. Water filter, part DA29-00020B.",
        attached_to: [{ type: "item", id: "seed-item-fridge", name: "Fridge" }],
      }),
    );
    const changes = document.changes as { id: string; tool: string }[];
    expect(changes.map(({ id, tool }) => ({ id, tool }))).toEqual([
      { id: "id-0004", tool: "request_upload_link" },
    ]);
    const fridge = yield* getting("item", "seed-item-fridge");
    expect(fridge.documents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "id-0002", kind: "receipt" })]),
    );
    const found = yield* call(search, { words: "DA29-00020B" }).pipe(Effect.map(answer));
    expect(JSON.stringify(found)).toContain("id-0002");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the same file twice is stored once, and its Document is attached to both", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const before = yield* counting;
    const first = yield* requesting(RECEIPT);
    const { arrival } = yield* arriving(first.link as string);
    const documentId = arrival.ok ? arrival.document_id : "";
    const second = yield* requesting({ ...RECEIPT, title: "Another title", attach_to: [HEARTH] });

    const again = yield* arriving(second.link as string);
    const once = yield* arriving(second.link as string);

    expect(again.stored).toEqual([]);
    expect(again.arrival).toEqual({
      ok: true,
      document_id: documentId,
      change_id: expect.any(String),
    });
    expect(once.arrival).toEqual({ ok: true, document_id: documentId, change_id: null });
    const document = yield* getting("document", documentId);
    // Nothing else about it changes.
    expect(document.title).toBe("Fridge water filter order");
    expect(document.attached_to).toEqual([
      { type: "item", id: "seed-item-fridge", name: "Fridge" },
      { type: "vendor", id: "seed-vendor-hearth", name: "Hearth Heating and Air" },
    ]);
    expect((yield* counting).documents).toBe(before.documents + 1);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("the same file again fills in what its Document does not say yet, and nothing else", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const bare = { title: RECEIPT.title, kind: RECEIPT.kind, attach_to: RECEIPT.attach_to };
    const { arrival } = yield* arriving((yield* requesting(bare)).link as string);
    if (!arrival.ok) return expect.unreachable();
    const { document_id: documentId } = arrival;

    // Nothing new to attach, but a text, a date, a total, and a Vendor to fill in.
    const filling = yield* arriving((yield* requesting(RECEIPT)).link as string);
    if (!filling.arrival.ok) return expect.unreachable();
    // What the Document says now stays, whatever a later call says.
    const later = yield* arriving(
      (yield* requesting({ ...RECEIPT, title: "Other", total: 1, text: "Other words." }))
        .link as string,
    );

    expect(filling.stored).toEqual([]);
    expect(filling.arrival.change_id).toEqual(expect.any(String));
    expect(later.arrival).toEqual({ ok: true, document_id: documentId, change_id: null });
    const filled = expect.objectContaining({
      title: "Fridge water filter order",
      doc_date: "2026-10-04",
      total: 49.99,
      vendor: "Corner Hardware",
      text: "Order 1182. Water filter, part DA29-00020B.",
    });
    expect(yield* getting("document", documentId)).toEqual(filled);
    const found = yield* call(search, { words: "DA29-00020B" }).pipe(Effect.map(answer));
    expect(JSON.stringify(found)).toContain(documentId);

    // The Change that filled it in is undone like any other, with the Vendor it made.
    const undone = yield* undoing(filling.arrival.change_id!);
    expect(undone.taken_out).toEqual([
      { type: "vendor", id: expect.any(String), name: "Corner Hardware" },
    ]);
    expect(yield* getting("document", documentId)).toEqual(
      expect.objectContaining({ doc_date: null, total: null, vendor: null, text: null }),
    );
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undo refuses to put a Document back while another Document has its file", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const receipt = { ...RECEIPT, vendor: null };
    const first = (yield* arriving((yield* requesting(receipt)).link as string)).arrival;
    if (!first.ok) return expect.unreachable();
    const takenOut = yield* undoing(first.change_id!);
    const second = (yield* arriving((yield* requesting(receipt)).link as string)).arrival;
    if (!second.ok) return expect.unreachable();

    const refused = yield* undoing(takenOut.change_id as string);

    expect(refused.refused).toBe(
      `Nothing was undone, because a record would come back with what another record has now, and no two records can have the same. Undo the Change that made the other record first:
The Document "Fridge water filter order" (${first.document_id}) would have the same file as the Document "Fridge water filter order" (${second.document_id}).`,
    );
    yield* undoing(second.change_id!);
    yield* undoing(takenOut.change_id as string);
    expect((yield* getting("document", first.document_id)).id).toBe(first.document_id);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a Document attached to nothing is `pending`, and `filed` once a file attaches it", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const alone = yield* requesting({ ...RECEIPT, attach_to: [] });
    const { arrival } = yield* arriving(alone.link as string);
    const documentId = arrival.ok ? arrival.document_id : "";
    expect((yield* getting("document", documentId)).status).toBe("pending");

    yield* arriving((yield* requesting(RECEIPT)).link as string);

    expect((yield* getting("document", documentId)).status).toBe("filed");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a file is turned away, and nothing stored, when a record went or the link ran out", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO items (id, name, category_id) VALUES ('item-kettle', 'Kettle', 'other')`;
    const asked = yield* requesting({
      ...RECEIPT,
      attach_to: [{ type: "item", id: "item-kettle" }],
    });
    yield* sql`DELETE FROM items WHERE id = 'item-kettle'`;
    const before = yield* counting;

    const gone = yield* arriving(asked.link as string);
    expect(gone.arrival).toEqual({
      ok: false,
      refused: expect.stringContaining('the Item with the id "item-kettle" was deleted'),
    });
    expect(gone.stored).toEqual([]);

    const later = yield* requesting(RECEIPT);
    yield* TestClock.adjust("15 minutes");
    const ranOut = yield* arriving(later.link as string);
    expect(ranOut.arrival).toEqual({ ok: false, refused: expect.stringContaining("run out") });
    expect(ranOut.stored).toEqual([]);
    expect((yield* counting).documents).toBe(before.documents);
  }).pipe(Effect.provide(TestDatabase)),
);

// A request is no record, so nothing stops an undo from taking out the Property it is for.
it.effect("a file is turned away, and nothing stored, when its Property was taken out since", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const made = yield* call(saveProperty, { name: "Cabin", tenure: "own" }).pipe(
      Effect.map(answer),
    );
    const asked = yield* requesting({ ...RECEIPT, attach_to: [], property: "Cabin" });
    yield* undoing(made.change_id as string);

    const { arrival, stored } = yield* arriving(asked.link as string);

    expect(arrival).toEqual({
      ok: false,
      refused: expect.stringMatching(/the Property with the id "[^"]+" was deleted/),
    });
    expect(stored).toEqual([]);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("a file the bucket would not store leaves no Document", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const { link } = yield* requesting(RECEIPT);
    const before = yield* counting;

    const { arrival } = yield* arriving(link as string, PNG, "The file did not match its hash.");

    expect(arrival).toEqual({ ok: false, refused: "The file did not match its hash." });
    expect(yield* counting).toEqual(before);
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("undoing a file's Change takes its Document out, and undoing that puts it back", () =>
  Effect.gen(function* () {
    yield* loadHousehold;
    yield* todayIs(TODAY);
    const { arrival } = yield* arriving((yield* requesting(RECEIPT)).link as string);
    if (!arrival.ok) return expect.unreachable();
    const whole = yield* getting("document", arrival.document_id);

    const undone = yield* undoing(arrival.change_id!);
    expect(undone.taken_out).toEqual([
      { type: "document", id: arrival.document_id, name: "Fridge water filter order" },
      { type: "vendor", id: "id-0003", name: "Corner Hardware" },
    ]);
    expect((yield* getting("document", arrival.document_id)).refused).toContain("no Document");

    yield* undoing(undone.change_id as string);
    const back = yield* getting("document", arrival.document_id);
    expect({ ...back, changes: undefined, updated_at: undefined }).toEqual({
      ...whole,
      changes: undefined,
      updated_at: undefined,
    });
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "undoing the Change that made an Item is refused while a Document is attached to it",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      const sql = yield* SqlClient.SqlClient;
      const saved = yield* call(saveItem, { name: "Kettle" }).pipe(Effect.map(answer));
      const [kettle] = saved.created as { id: string }[];
      if (kettle === undefined) return expect.unreachable();
      const { arrival } = yield* arriving(
        (yield* requesting({ ...RECEIPT, attach_to: [{ type: "item", id: kettle.id }] }))
          .link as string,
      );
      if (!arrival.ok) return expect.unreachable();

      const refused = yield* undoing(saved.change_id as string);

      expect(refused.refused).toContain(`is used by the Document "Fridge water filter order"`);
      expect(yield* sql`SELECT id FROM items WHERE id = ${kettle.id}`).toHaveLength(1);
    }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "the same file after its Document was deleted makes a new Document, and the delete stays",
  () =>
    Effect.gen(function* () {
      yield* loadHousehold;
      yield* todayIs(TODAY);
      const receipt = { ...RECEIPT, vendor: null };
      const first = (yield* arriving((yield* requesting(receipt)).link as string)).arrival;
      if (!first.ok) return expect.unreachable();
      const removal = yield* callAsClient(deleteRecord, {
        type: "document",
        id: first.document_id,
      }).pipe(Effect.map(answer));
      expect(removal.removed).toEqual([
        { type: "document", id: first.document_id, name: "Fridge water filter order" },
      ]);

      // No Document has the file now, so it is stored again, under the new Document's id.
      const again = yield* arriving((yield* requesting(receipt)).link as string);
      if (!again.arrival.ok) return expect.unreachable();
      const second = again.arrival.document_id;
      expect(second).not.toBe(first.document_id);
      expect(again.stored).toEqual([second]);

      const refused = yield* undoing(removal.change_id as string);
      expect(refused.refused).toBe(
        `Nothing was undone, because a record would come back with what another record has now, and no two records can have the same. Undo the Change that made the other record first:
The Document "Fridge water filter order" (${first.document_id}) would have the same file as the Document "Fridge water filter order" (${second}).`,
      );
    }).pipe(Effect.provide(TestDatabase)),
);
