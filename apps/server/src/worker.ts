import { hello } from "@attic/core";
import { Effect } from "effect";

export default {
  async fetch(): Promise<Response> {
    return new Response(await Effect.runPromise(hello));
  },
} satisfies ExportedHandler;
