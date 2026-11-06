import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { filesPastKeeping, pastKeeping, type ListedFile } from "../src/document.ts";
import { todayIs } from "./call.ts";
import { TestDatabase } from "./TestDatabase.ts";

// What the nightly run removes from the bucket, decided apart from R2. A list of local R2 gives
// each file the time R2 got it, and a test cannot set that time, so here the files are made up.
// What the run does with the answer is tested through the Worker.

const TODAY = "2026-11-05";

// A file under this key, which R2 got at this time.
const fileAt = (key: string, uploaded: string): ListedFile => ({
  key,
  size: 100,
  uploaded: new Date(uploaded),
});

// A Document whose file is under its id, as an upload makes one.
const documentWithFile = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO documents (id, title, r2_key, mime_type, sha256)
             VALUES (${id}, ${id}, ${id}, 'image/png', ${`hash-${id}`})`;
});

// A Change made at this time that wrote the Document with this id: made it, or took it out.
let changes = 0;
const changeOf = Effect.fnUntraced(function* (
  documentId: string,
  at: string,
  did: "made" | "took out",
) {
  const sql = yield* SqlClient.SqlClient;
  const id = `change-${String(++changes).padStart(3, "0")}`;
  yield* sql`INSERT INTO changes (id, tool, created_at) VALUES (${id}, 'test', ${at})`;
  const [before, after] = did === "made" ? [null, "{}"] : ["{}", null];
  yield* sql`INSERT INTO change_records (change_id, entity_type, entity_id, before, after)
             VALUES (${id}, 'document', ${documentId}, ${before}, ${after})`;
});

it("a file is past keeping more than 30 days after, and not on the 30th", () => {
  const since = Date.parse("2026-10-06T12:00:00Z");
  expect(pastKeeping(since, Date.parse("2026-11-05T12:00:00Z"))).toBe(false);
  expect(pastKeeping(since, Date.parse("2026-11-05T12:00:01Z"))).toBe(true);
});

it.effect("a file no Document has goes 30 days after its latest Change, or after R2 got it", () =>
  Effect.gen(function* () {
    yield* todayIs(TODAY);
    yield* documentWithFile("KEPT");
    // Taken out 31 days ago, and 29 days ago.
    yield* changeOf("OUT_LONG", "2026-10-05T12:00:00.000Z", "took out");
    yield* changeOf("OUT_LATELY", "2026-10-07T12:00:00.000Z", "took out");
    // Taken out long ago, put back by an undo, and taken out again lately.
    yield* changeOf("OUT_AGAIN", "2026-09-10T12:00:00.000Z", "took out");
    yield* changeOf("OUT_AGAIN", "2026-09-15T12:00:00.000Z", "made");
    yield* changeOf("OUT_AGAIN", "2026-10-20T12:00:00.000Z", "took out");

    const files = [
      // A Document has it, however long R2 has had it.
      fileAt("KEPT", "2025-01-01T00:00:00Z"),
      fileAt("OUT_LONG", "2026-09-01T00:00:00Z"),
      fileAt("OUT_LATELY", "2026-09-01T00:00:00Z"),
      fileAt("OUT_AGAIN", "2026-09-01T00:00:00Z"),
      // No Change has these: the write after R2 took them failed.
      fileAt("NEVER_WRITTEN", "2026-10-01T00:00:00Z"),
      fileAt("JUST_SENT", "2026-11-05T11:59:00Z"),
    ];

    expect(yield* filesPastKeeping(files)).toEqual({
      removable: [files[1], files[4]],
      waiting: 3,
    });
  }).pipe(Effect.provide(TestDatabase)),
);
