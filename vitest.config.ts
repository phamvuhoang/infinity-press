import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDirectory,
      "server-only": path.join(rootDirectory, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "jsdom",
    // The default pool, deliberately - do not reinstate `pool: "vmThreads"` without reading this.
    //
    // vmThreads was used here to reuse one jsdom environment per worker rather than rebuilding it
    // per file, worth roughly 7s on this suite (2.3s vs 9.7s). It also loads externalized CommonJS
    // through Node's own resolver instead of Vite's transform, and `server.deps.inline` does not
    // reach those modules. On Node 22 - which .github/workflows/ci.yml pins - that makes
    // `sanitize-html`'s `require('htmlparser2')` throw `Cannot use import statement outside a
    // module`, and lib/epub/{process,sanitize,worker}.test.ts fail to *load*: 3 suites, 97 tests
    // reported as "no tests" rather than as failures. Node 23+ resolves `require(esm)`
    // transparently, so it is invisible on a newer local toolchain and surfaced only on this
    // repository's first ever CI run, after the whole branch had been verified locally.
    //
    // Inlining does not fix it under that pool - tried with "htmlparser2", then with
    // "sanitize-html" alongside it; neither changed the result. The default pool passes on both
    // Node 22 and Node 26, which is what this now relies on. `isolate: false` would recover most of
    // the lost time by reusing workers across files; that is deliberately not taken, because these
    // suites share module state and cross-file contamination has already cost this project real
    // time. If you want the speed back, run the suite on Node 22 before believing it works.
    // `.worktrees/**` holds git worktrees of other branches of this same repository, so without
    // this the runner collects a second copy of every suite - from a branch this one does not
    // control and whose failures it cannot fix.
    exclude: [...configDefaults.exclude, "e2e/**", ".worktrees/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
