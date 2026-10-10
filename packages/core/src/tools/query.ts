import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { defineTool, ToolError } from "../tool.ts";

// The most rows one call returns. The query is run for one more, which is how a result that
// was cut is told from one that just fits.
const MOST_ROWS = 500;

const CUT = `Only the first ${MOST_ROWS} rows are here, and the query matched more. Narrow it, total it with count() or sum(), or page through it with LIMIT and OFFSET.`;

// What D1 sends back for a statement: its rows, and what running it did to the database.
// `SqlClient` has no word for the second part, so this tool asks for the driver's own result,
// and that is D1's.
const decodeResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    results: Schema.Array(Schema.Unknown),
    meta: Schema.Struct({ changed_db: Schema.Boolean }),
  }),
);

// The D1 binding has no read-only mode, so the wrapper and the semicolon rule are all that keep
// this tool from writing. If D1 ever says the database changed, one of them has a hole.
const CHANGED =
  "This query changed the database, which query must never do. Nothing was undone. Stop, and tell whoever runs this Attic what SQL you sent: the read-only guard has a hole.";

// The caller's SQL goes inside this. Only a SELECT or a WITH is valid there, so anything else
// is a syntax error before it runs. The line breaks keep a `--` comment at the end of the
// caller's SQL from swallowing the closing bracket.
const OPEN = "SELECT * FROM (\n";
const CLOSE = `\n) LIMIT ${MOST_ROWS + 1}`;

// A statement the database turned down, in the database's own words, so that whoever wrote the
// SQL can fix it. SQLite says where a mistake is by counting from the start of what it ran,
// which begins with the wrapper, so the count is moved back to the caller's own SQL.
const turnedDown = ({ reason: { cause } }: SqlError) => {
  const said = (cause instanceof Error ? cause.message : String(cause)).replace(
    / at offset (\d+)/,
    (_, offset: string) => ` at offset ${Number(offset) - OPEN.length}`,
  );
  return new ToolError({
    message: `The database turned the query down: ${said}
query runs one SELECT or WITH statement, so anything else is a syntax error. Call get_schema for the tables, views, and columns there are.`,
  });
};

// D1 runs every statement in a string it is given, and a string can close the wrapper early and
// open it again: `SELECT 1); DELETE FROM notes; SELECT * FROM (SELECT 2`. A second statement
// needs a semicolon before it, so none gets through, wherever it sits. Telling a semicolon in a
// string from one between statements would take a SQL parser.
const SEMICOLON =
  "query runs one statement and refuses any semicolon, even at the end or inside a string or a comment. Take it out. To match a semicolon in text, write char(59), as in `'a' || char(59) || 'b'`.";

export const query = defineTool({
  name: "query",
  description: `Runs one read-only SQL statement, a SELECT or a WITH, on Attic's SQLite database. It is for the questions no other tool answers. Call get_schema first: it returns the tables, the views, and the conventions the data follows. Rows come back as stored, with nothing formatted: money is integer cents, a date may be a Partial date, and \`data\` and the other JSON columns are text that json_extract reads. At most ${MOST_ROWS} rows come back, with a note when the result was cut. Any semicolon is refused, even at the end or inside a string.`,
  input: Schema.Struct({
    sql: Schema.String.annotate({
      description: "One SELECT or WITH statement in SQLite's dialect, with no semicolon.",
    }),
  }),
  annotations: { readOnlyHint: true },
  run: (input) =>
    Effect.gen(function* () {
      if (input.sql.includes(";")) return yield* new ToolError({ message: SEMICOLON });

      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql
        .unsafe(`${OPEN}${input.sql}${CLOSE}`)
        .raw.pipe(Effect.mapError(turnedDown));
      const { results, meta } = yield* Effect.orDie(decodeResult(result));
      if (meta.changed_db) {
        yield* Effect.logError(`query changed the database. The SQL was: ${input.sql}`);
        return yield* new ToolError({ message: CHANGED });
      }

      // The count is taken here and not from the LIMIT, which a query can comment out.
      return results.length > MOST_ROWS
        ? { rows: results.slice(0, MOST_ROWS), note: CUT }
        : { rows: results };
    }),
});
