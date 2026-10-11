import { Context, Effect, Layer, Schema } from "effect";

/** An amount a tool was given in dollars, as it is stored: integer cents. */
export const inCents = (dollars: number) => Math.round(dollars * 100);

// Whether an amount is a whole number of cents, and one a number can hold exactly. 19.99 times
// 100 is not quite 1999 in floating point, so the amount is held against its cents turned back
// into dollars, which is the same number when it had no more than two decimal places.
const isWholeCents = (dollars: number) => {
  const cents = inCents(dollars);
  return Number.isSafeInteger(cents) && cents / 100 === dollars;
};

/**
 * An amount of money in a tool's input: dollars, in the one currency the deployment is
 * configured for. It is stored as integer cents, so an amount below zero, or with more than two
 * decimal places, is turned away. It is given what the amount is of. The description goes on
 * before the checks, because one put on after them is left out of the JSON Schema a client
 * reads.
 */
export const amount = (description: string) =>
  Schema.Finite.annotate({
    description: `${description} In dollars, with at most two decimal places, such as 1299.99.`,
  }).check(
    Schema.isGreaterThanOrEqualTo(0, { message: "Expected an amount that is not below zero." }),
    Schema.makeFilter(isWholeCents, {
      message: "Expected an amount with at most two decimal places, such as 1299.99.",
    }),
  );

/**
 * The one currency the deployment is configured for, as an ISO code such as USD. Money is
 * stored as a bare number of cents, so this is only used to write an amount out in words.
 */
export class Currency extends Context.Service<Currency, { readonly code: string }>()(
  "@attic/core/Currency",
) {
  /** The currency with this ISO code. */
  static readonly layer = (code: string) => Layer.succeed(Currency, Currency.of({ code }));
}

// Making a formatter costs far more than using one, so each currency's is made once and kept.
const formatters = new Map<string, Intl.NumberFormat>();

const formatterFor = (code: string) => {
  let known = formatters.get(code);
  if (known === undefined) {
    known = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    formatters.set(code, known);
  }
  return known;
};

/** Cents as a Note writes them out, in the configured currency: $1,450.50. */
export const formatCents = (cents: number) =>
  Effect.map(Currency, ({ code }) => formatterFor(code).format(cents / 100));
