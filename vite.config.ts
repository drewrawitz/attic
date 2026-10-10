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
      // These two are tasks, not package.json scripts, so that they can opt out of the cache.
      // A cached command gets no terminal, and `alchemy deploy` needs one to ask before it
      // changes anything. A deploy must also never be replayed from the cache.
      dev: { command: "alchemy dev", cache: false },
      deploy: { command: "alchemy deploy --stage prod", cache: false },
    },
  },
  // The root tests run the stack in alchemy.run.ts on local simulators. Each package has its own.
  test: {
    include: ["test/**/*.test.ts"],
  },
});
