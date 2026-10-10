import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { getSchema } from "../../src/tools/get-schema.ts";
import { call } from "../call.ts";
import { migrations, TestDatabase } from "../TestDatabase.ts";

interface Definition {
  readonly name: string;
  readonly sql: string;
}

// What a client reads when it calls get_schema.
interface Published {
  readonly tables: ReadonlyArray<Definition>;
  readonly views: ReadonlyArray<Definition>;
  readonly categories: ReadonlyArray<Category>;
  readonly data_keys: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly partial_dates: string;
  readonly conventions: string;
}

interface Category {
  readonly id: string;
  readonly name: string;
  readonly expects: ReadonlyArray<string>;
  readonly children: ReadonlyArray<Category>;
}

const published = call(getSchema, {}).pipe(Effect.map(({ text }) => JSON.parse(text) as Published));

// The names the migrations create.
const created = (kind: "TABLE" | "VIEW") =>
  migrations
    .flatMap((migration) => [...migration.matchAll(new RegExp(`^CREATE ${kind} (\\w+)`, "gm"))])
    .map((match) => match[1])
    .sort();

const names = (definitions: ReadonlyArray<Definition>) =>
  definitions.map(({ name }) => name).sort();

it.effect("get_schema returns every table and view in the migrations, and no others", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // D1 and Alchemy keep tables of their own beside Attic's.
    yield* sql`CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)`;
    yield* sql`CREATE TABLE __alchemy_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL)`;

    const { tables, views } = yield* published;

    expect(names(tables)).toEqual(created("TABLE"));
    expect(names(views)).toEqual(created("VIEW"));
    expect(tables.find(({ name }) => name === "properties")?.sql).toMatch(
      /^CREATE TABLE properties \(\n {2}id {10}TEXT PRIMARY KEY,/,
    );
    expect(views.find(({ name }) => name === "current_properties")?.sql).toMatch(
      /^CREATE VIEW current_properties AS\nSELECT \* FROM properties/,
    );
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect(
  "get_schema returns the Category tree, a child under its parent, with what each expects",
  () =>
    Effect.gen(function* () {
      const { categories } = yield* published;

      expect(categories.find(({ id }) => id === "electronics")).toEqual({
        id: "electronics",
        name: "Electronics",
        expects: ["brand", "model", "serial"],
        children: [
          { id: "audio-video", name: "Audio and video", expects: [], children: [] },
          { id: "computers", name: "Computers", expects: [], children: [] },
          { id: "networking", name: "Networking", expects: [], children: [] },
        ],
      });
      // A child is listed under its parent only, not a second time at the top.
      expect(categories.map(({ id }) => id)).not.toContain("computers");
      expect(categories.map(({ id }) => id)).toContain("other");
    }).pipe(Effect.provide(TestDatabase)),
);

const ids = (categories: ReadonlyArray<Category>): ReadonlyArray<string> =>
  categories.flatMap((category) => [category.id, ...ids(category.children)]);

// Nothing in the schema stops two Categories from being each other's parent.
it.effect("get_schema lists every Category once, even when parents form a loop", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // power-tools already sits under tools, so this closes a loop.
    yield* sql`UPDATE categories SET parent_id = 'power-tools' WHERE id = 'tools'`;
    const all = yield* sql<{ id: string }>`SELECT id FROM categories ORDER BY id`;

    const { categories } = yield* published;

    expect([...ids(categories)].sort()).toEqual(all.map(({ id }) => id));
  }).pipe(Effect.provide(TestDatabase)),
);

// The list on issue 3, with the shapes it gives for the keys that hold more than one value.
it.effect("get_schema publishes the well-known data keys for each kind of record", () =>
  Effect.gen(function* () {
    const { data_keys } = yield* published;

    const keys = Object.fromEntries(
      Object.entries(data_keys).map(([record, described]) => [record, Object.keys(described)]),
    );
    expect(keys).toEqual({
      item: [
        "brand",
        "model",
        "serial",
        "warranty_until",
        "parts",
        "quantity",
        "condition",
        "listing",
        "sold_to",
        "donated_to",
        "claim_number",
      ],
      space: ["sqft", "paint", "flooring", "counters"],
      property: ["lease_until", "paint"],
      work: ["permit", "payments", "replaced"],
    });

    const missingFrom = (text: string | undefined, words: ReadonlyArray<string>) =>
      words.filter((word) => !text?.includes(word));
    expect(missingFrom(data_keys.item?.parts, ["slug", "name", "part_number"])).toEqual([]);
    expect(missingFrom(data_keys.item?.listing, ["where", "asking_cents", "url"])).toEqual([]);
    expect(
      missingFrom(data_keys.space?.paint, [
        "walls",
        "trim",
        "ceiling",
        "brand",
        "color",
        "code",
        "sheen",
      ]),
    ).toEqual([]);
    expect(data_keys.property?.paint).toContain("A Space's own entry wins");
  }).pipe(Effect.provide(TestDatabase)),
);

it.effect("get_schema warns that comparing dates as plain text misses Partial dates", () =>
  Effect.gen(function* () {
    const { partial_dates } = yield* published;

    expect(partial_dates).toContain("date >= '2023-03'");
    expect(partial_dates).toContain("a row dated '2023'");
  }).pipe(Effect.provide(TestDatabase)),
);

// The header is the comment the first migration opens with. SQLite does not keep it, so
// get_schema carries a copy, and this fails if the two drift apart.
it.effect("the conventions get_schema returns are the migration's header, word for word", () =>
  Effect.gen(function* () {
    const lines = migrations[0]!.split("\n");
    const header = lines
      .slice(
        0,
        lines.findIndex((line) => !line.startsWith("--")),
      )
      .map((line) => line.replace(/^-- ?/, ""));

    const { conventions } = yield* published;

    // The header's first line is the file's name. The conventions are everything after it.
    expect(header.slice(0, 2)).toEqual(["0001_init.sql", ""]);
    expect(conventions).toBe(header.slice(2).join("\n"));
  }).pipe(Effect.provide(TestDatabase)),
);
