import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { ATTIC } from "../../household/stack.ts";
import { deploy } from "./harness.ts";

// The Worker's R2 bucket, by the name it has in alchemy.run.ts.
const FILES_BUCKET = "FILES";

// A file a test puts in `FILES`: its key there, its bytes, and its content type.
export interface TestFile {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

// What the Action below is given. The bytes go in as base64, because an Action's input is
// kept as JSON.
interface FilesInput {
  readonly emptiedFirst: boolean;
  readonly added: ReadonlyArray<{ key: string; base64: string; contentType: string }>;
}

// Puts objects in the bucket the Worker reads as `FILES`, which no tool does until step 6 of
// the `v1` route. Like `onDatabase`, it is a small stack that finds the bucket the `attic`
// stack made and holds one Action, which reaches local R2 through Alchemy's own client. Its
// state stays on this machine, as the rest of the tests' does (ADR 0013).
const filesStack = (emptiedFirst: boolean, files: ReadonlyArray<TestFile>) =>
  Alchemy.Stack(
    "attic-test-files",
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const filesBucket = yield* Cloudflare.R2.Bucket.ref(FILES_BUCKET, { stack: ATTIC });

      const Files = Alchemy.Action(
        "Files",
        Effect.gen(function* () {
          const r2 = yield* Cloudflare.R2.ReadWriteBucket(filesBucket);
          return (input: FilesInput) =>
            Effect.gen(function* () {
              let removed = 0;
              if (input.emptiedFirst) {
                // No test leaves more behind than one list holds.
                const { objects } = yield* r2.list();
                if (objects.length > 0) yield* r2.delete(objects.map(({ key }) => key));
                removed = objects.length;
              }
              // One after another: the simulator turns away two writes at once.
              for (const { key, base64, contentType } of input.added) {
                yield* r2.put(key, Buffer.from(base64, "base64"), {
                  httpMetadata: { contentType },
                });
              }
              return { removed, added: input.added.length };
            });
        }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
      );

      return yield* Files({
        emptiedFirst,
        added: files.map(({ key, body, contentType }) => ({
          key,
          base64: body.toString("base64"),
          contentType,
        })),
      });
    }),
  );

/** Makes `FILES` hold these files and nothing else. With none, it is left empty. */
export const filesAre = (...files: ReadonlyArray<TestFile>) =>
  deploy(filesStack(true, files), { force: true });

/** Puts these files in `FILES`, beside what it holds. */
export const addFiles = (...files: ReadonlyArray<TestFile>) =>
  deploy(filesStack(false, files), { force: true });
