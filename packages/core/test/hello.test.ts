import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { hello } from "../src/index.ts";

it.effect("hello greets from Attic", () =>
  Effect.gen(function* () {
    expect(yield* hello).toBe("Hello from Attic");
  }),
);
