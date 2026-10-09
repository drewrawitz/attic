import { Effect } from "effect";

// Placeholder that proves the Effect wiring from core to the Worker.
// It goes away when the first real service lands.
export const hello: Effect.Effect<string> = Effect.succeed("Hello from Attic");
