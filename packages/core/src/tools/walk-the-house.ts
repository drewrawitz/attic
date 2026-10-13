import { Effect } from "effect";
import type { Prompt } from "../prompt.ts";
import { MOST_IN_ONE_CALL } from "../save.ts";
import { defineTool, NoInput } from "../tool.ts";

// The name it was planned under. "House" is a word the glossary avoids for a Property, so the
// name is the one place it is used: the script says Property.
const NAME = "walk_the_house";

// The script: one fixed text, written for a client to follow. It ships twice, as the tool and as
// the prompt below, and both are this one text, so the two cannot come apart.
//
// What it sets in backticks is the name of a tool, or `data`, or a key of `data` written as
// `data.model`, and nothing else. That is how a test reads the tools' names out of it and holds
// them to the list of tools, so that a tool that is renamed breaks the test and not the
// interview.
//
// It tells the client not to ask for photos or Receipts, because no tool takes a Document yet.
// They come with step 6 of the `v1` route.
const SCRIPT = `This is the script for going through a Property with the User, one Space at a time, to put on record its Spaces, their size and paint, and the Items in them, with their models. Follow the steps in order. Ask a question or two at a time, and save as you go.

1. Settle which Property this is. Ask the User for its name, unless that is already clear. Read it with \`get_record\`, which takes a Property by its name and returns its Spaces and the Items at it. If it is not on record, the error says which Properties are, and a new one is created with \`save_property\`. Give this Property in every call that takes one. Then read \`get_schema\` once, for the Category tree, the keys of \`data\` each Category expects, and the well-known keys of \`data\`.

2. Call \`gaps\` for the Property. It lists what is on record with something still missing, grouped by Space: a Space with no size or no paint, and an Item with no Price, no date, or nothing under a key its Categories expect. Tell the User in a sentence how much is missing.

3. Go one Space at a time. Start with the one the User is in now, and let them say which comes next. If the Space is on record, read it with \`get_record\`, by the id the Property's record gave: it has its size, its paint, and the Items in it, so ask only for what is missing. Ask for the Space's size in square feet, and for its paint by surface: the brand, color, code, and sheen on the walls, the trim, and the ceiling. Save them with \`save_space\`, under \`data.sqft\` and \`data.paint\`. Paint that is the same in every Space, such as the trim, goes on the Property once, with \`save_property\`.

4. Ask what is in the Space, and save its Items with \`save_item\`, as one list of up to ${MOST_IN_ONE_CALL}. Each entry of the list has fields of its own, with this Property and this Space among them.
   - One Item is one line on an insurance claim. A matching set, such as six dining chairs, is one Item with \`data.quantity\`.
   - Save each one as a Fixture, which stays with the Property when the User leaves, or as a Belonging, which is the User's own. Ask when it is not clear which.
   - Give each one a Category from the tree.
   - Where a Category of the Item expects a key, such as \`data.model\` or \`data.serial\`, ask for it, and have the User read it off the Item itself, from its plate or its sticker.
   - Ask what was paid for it and when it was bought, and leave out what the User does not know. A date can be a year, or a year and a month.
   - An Item that is on record already is updated by its id. Saved by its name, it would be there twice.

5. Save as you go: one Space, with its Items, before the next. Then nothing is lost if the conversation ends. After each save, tell the User what was saved. A save that was wrong is put right with \`undo\`, which takes the id of the Change the save returned.

6. When every Space is done, or the User wants to stop, call \`gaps\` again. Tell the User what is still missing, and offer to carry on another day.

Do not:
- Guess a model, a serial number, a Price, or a date. Save what the User said or read out, and nothing else. What is left out stays missing, and \`gaps\` shows it the next time.
- Make a new Category where one in the tree fits. \`save_category\` is for an Item that none fits.
- Ask for photos or Receipts. Attic cannot take them yet.`;

const DESCRIPTION = `Returns the script for going through a Property with the User: an interview, one Space at a time, that puts on record its Spaces, their size and paint, and the Items in them, with their models. Call it when the User wants to set up a Property, or to go through one, and then follow what comes back. The script says which tools to call and in what order. This tool reads no record and writes none. It takes no input.`;

export const walkTheHouse = defineTool({
  name: NAME,
  description: DESCRIPTION,
  input: NoInput,
  annotations: { readOnlyHint: true },
  run: () => Effect.succeed(SCRIPT),
});

/** The same script for a client that shows prompts. */
export const walkTheHousePrompt: Prompt = {
  name: NAME,
  description:
    "Go through a Property with the User, one Space at a time, and put on record its Spaces, their size and paint, and the Items in them, with their models.",
  text: SCRIPT,
};
