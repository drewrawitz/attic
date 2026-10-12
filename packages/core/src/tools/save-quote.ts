import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { partialDate } from "../dates.ts";
import { amount, inCents } from "../money.ts";
import { projectWith } from "../project.ts";
import { joinedName, SHAPES } from "../records.ts";
import {
  dataPatch,
  definedColumns,
  insertRow,
  nameText,
  refuseGivenAndCleared,
  runSave,
  SAVE_ANNOTATIONS,
  updateRow,
  valueOrCleared,
} from "../save.ts";
import { defineTool, noRecord, optional, ToolError } from "../tool.ts";
import { vendorOrNew } from "../vendor.ts";
import { Ids } from "../write.ts";
import { readRecord } from "./get-record.ts";

const NO_PROJECT_OR_VENDOR =
  "Give a Project and a Vendor to save a Quote, or the id of the Quote to update.";

const DESCRIPTION = `Creates or updates a Quote: what one Vendor said a Project would cost. A Quote is always on a Project, so save the Project first with save_project, and give its id here.

A Project has one Quote from each Vendor. So without an id, the Project and the Vendor say which Quote it is: if the Project already has a Quote from that Vendor it is updated, and otherwise a new one is created. That is how a revised Quote takes the place of the old one, and a field the save leaves out stays as it was. With an id, the Quote with that id is updated, and a \`project\` or a \`vendor\` given with it is its new Project or its new Vendor. So to put right a Quote that was saved under the wrong Vendor, give its id and the right one. A field that is left out, or sent as null, stays as it is. To empty a field, name it in \`clear\`.

\`vendor\` is who gave the Quote, by name, matched whatever its case. One that is not there yet is created, and the reply lists it, so check the reply for a Vendor you did not mean to make.

\`amount\` is what the Vendor said the Project would cost, in dollars. It is not what was paid: that is the Cost of the Work, which is logged with log_work once the Work is done. \`quoted_on\` is the date of the Quote, and may be a Partial date. Money inside \`data\` is not converted. It is stored as written: integer cents under a key ending in _cents.

\`data\` is a merge patch, so a save adds to what is there. What the amount covers goes in \`data.includes\`.

A Quote takes no Note. A Note about one goes on its Project, with add_note or with the \`note\` of save_project.

get_record takes no Quote, because a Quote comes back with its Project. So what comes back here is the id of the Change that recorded the save, the Quote and any Vendor made on first use, and as \`project\` the Quote's Project as get_record returns it, with every Quote it has. A Quote has no name of its own. A reply names it by its Vendor and its Project, as in "Brightside Electric for Outdoor lighting".`;

// The fields a save can empty. A Quote always has a Project and a Vendor.
const CLEARABLE = ["amount", "quoted_on"] as const;

// A Quote a save gives the id of, as it is now.
interface Existing {
  readonly id: string;
  readonly project_id: string;
  readonly project_title: string;
  readonly vendor_id: string;
  readonly vendor_name: string;
}

const quoteNow = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const [quote] = yield* sql<Existing>`
    SELECT quote.id, quote.project_id, project.title AS project_title,
           quote.vendor_id, vendor.name AS vendor_name
      FROM quotes AS quote
      JOIN projects AS project ON project.id = quote.project_id
      JOIN vendors AS vendor ON vendor.id = quote.vendor_id
     WHERE quote.id = ${id}`;
  return quote === undefined ? yield* noRecord("quote", id) : quote;
});

// The Quote a Project has from a Vendor, if it has one.
const quoteFrom = Effect.fnUntraced(function* (projectId: string, vendorId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [quote] = yield* sql<{ id: string }>`
    SELECT id FROM quotes WHERE project_id = ${projectId} AND vendor_id = ${vendorId}`;
  return quote;
});

export const saveQuote = defineTool({
  name: "save_quote",
  description: DESCRIPTION,
  input: Schema.Struct({
    id: optional(
      Schema.String.annotate({
        description:
          "The id of the Quote to update, as its Project's record gives it. Leave it out to save a Quote by its Project and its Vendor.",
      }),
    ),
    project: optional(
      Schema.String.annotate({
        description:
          "The id of the Project the Quote is for, as search or get_record gives it. A new Quote needs one.",
      }),
    ),
    vendor: optional(
      nameText(
        "The Vendor who gave the Quote, by name, such as Brightside Electric. It is created if it is not there yet. A new Quote needs one.",
      ),
    ),
    amount: optional(amount("What the Vendor said the Project would cost. Not what was paid.")),
    quoted_on: optional(partialDate("The date of the Quote.")),
    data: optional(dataPatch("Facts about the Quote, such as includes.")),
    clear: optional(
      Schema.Array(Schema.Literals(CLEARABLE)).annotate({
        description:
          "Fields to empty. A field cannot be given a value and cleared in the same call. A Quote always has a Project and a Vendor, so those cannot be cleared.",
      }),
    ),
  }),
  annotations: SAVE_ANNOTATIONS,
  run: (given) =>
    Effect.gen(function* () {
      const { id, data, clear = [] } = given;
      const sql = yield* SqlClient.SqlClient;
      yield* refuseGivenAndCleared(given, clear);
      const wanted = valueOrCleared(clear);

      // The Quote's Project and its Vendor after the save: the ones the save gives, or the
      // ones the Quote has. The Project is looked up first, so that one that is not there
      // stops the save before a Vendor is made ready for it.
      const was = id === undefined ? undefined : yield* quoteNow(id);
      const project =
        given.project !== undefined
          ? yield* projectWith(given.project)
          : was === undefined
            ? undefined
            : { id: was.project_id, title: was.project_title };
      if (project === undefined) return yield* new ToolError({ message: NO_PROJECT_OR_VENDOR });
      const vendor =
        given.vendor !== undefined
          ? yield* vendorOrNew(given.vendor)
          : was === undefined
            ? undefined
            : { id: was.vendor_id, name: was.vendor_name, steps: [] };
      if (vendor === undefined) return yield* new ToolError({ message: NO_PROJECT_OR_VENDOR });

      // A Project has one Quote from each Vendor. Without an id, the one it has from this
      // Vendor is the Quote this save is about. A Vendor that is new has given none.
      const fromVendor =
        vendor.steps.length > 0 ? undefined : yield* quoteFrom(project.id, vendor.id);
      if (was !== undefined && fromVendor !== undefined && fromVendor.id !== was.id) {
        return yield* new ToolError({
          message: `The Project "${project.title}" already has a Quote from ${vendor.name}, with the id "${fromVendor.id}". A Project has one Quote from each Vendor. Update that one, or give this one another Vendor.`,
        });
      }
      const toUpdate = was ?? fromVendor;
      const repointed =
        was !== undefined && (project.id !== was.project_id || vendor.id !== was.vendor_id);

      const quote = {
        type: "quote",
        id: toUpdate?.id ?? (yield* (yield* Ids).next),
        // A Quote has no name of its own. It is called what `records.ts` says it is named by.
        name: joinedName(SHAPES.quote.namedBy, {
          vendor_id: vendor.name,
          project_id: project.title,
        }),
      } as const;
      const columns = definedColumns({
        // A Quote that stays with its Project and its Vendor has neither column set again.
        project_id: toUpdate === undefined || repointed ? project.id : undefined,
        vendor_id: toUpdate === undefined || repointed ? vendor.id : undefined,
        amount_cents: wanted(
          "amount",
          given.amount === undefined ? undefined : inCents(given.amount),
        ),
        quoted_on: wanted("quoted_on", given.quoted_on),
      });
      const row =
        toUpdate === undefined
          ? insertRow(sql, quote, columns, data)
          : updateRow(sql, quote, columns, data);

      const reply = yield* runSave([...vendor.steps, row]);
      return { ...reply, project: yield* readRecord("project", project.id) };
    }),
});
