import { DateTime, Effect, Schema } from "effect";

// The three ways a date is written. The schema's own CHECK takes these shapes and no others, but
// it also takes a month 13 and a day 30 in February, so a date is checked here before it gets
// that far.
const FORMS = "2023, 2023-06, or 2023-06-12";

// Whether a text is a year, a year and a month, or a full date, and names a period that is on
// the calendar. A date that is not on it, such as 2023-02-30, does not come back out of `Date`
// the way it went in.
const onTheCalendar = (text: string) => {
  const parts = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (parts === null) return false;
  const [, year, month = "01", day = "01"] = parts;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(`${year}-${month}-${day}`);
};

/**
 * A date in a tool's input: ISO text, which may be a Partial date. Anything else is turned
 * away with the three forms a date can take. It is given what the date is of, and adds how a
 * date is written. The description goes on before the check, because one put on after it is
 * left out of the JSON Schema a client reads.
 */
export const partialDate = (description: string) =>
  Schema.String.annotate({
    description: `${description} ISO text, which may be a Partial date: ${FORMS}.`,
  }).check(
    Schema.makeFilter(onTheCalendar, {
      message: `Expected a date that exists, written as ${FORMS}. A date can be a Partial date: a year, or a year and a month.`,
    }),
  );

/**
 * Today's date on the User's calendar: the date in the configured timezone, written as
 * 2023-06-12. The UTC date is a day ahead or behind for part of every day. The
 * `current_properties` view lives with that, and a tool does not.
 */
export const today = Effect.map(DateTime.nowInCurrentZone, DateTime.formatIsoDate);
