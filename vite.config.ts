import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    tasks: {
      // These are tasks, not package.json scripts, so that they can opt out of the cache.
      // A cached command gets no terminal, and `alchemy deploy` needs one to ask before it
      // changes anything. A deploy must also never be replayed from the cache.
      dev: { command: "alchemy dev", cache: false },
      deploy: { command: "alchemy deploy --stage prod", cache: false },
      // The made-up household in household/, into a stage's database and out of it again:
      // `vp run household:load --stage <stage>`. Each is a deploy of a stack that holds one
      // Action. `--force` runs the Action every time. Without it, Alchemy skips one whose
      // input is the same as the last time, so a second load in a row would do nothing.
      "household:load": { command: "alchemy deploy household/load.run.ts --force", cache: false },
      "household:remove": {
        command: "alchemy deploy household/remove.run.ts --force",
        cache: false,
      },
    },
  },
  // The root tests run the stack in alchemy.run.ts on local simulators. Each package has its own.
  // The files that run the Worker share one stage, one Worker, and one port, and one of them
  // changes the Worker's settings, so the files run one after another.
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
});
