import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  // `.worktrees/**` holds git worktrees of OTHER branches of this same repository. Linting them
  // means linting a second (and third) copy of the application: a clean branch fails its own
  // `npm run check` because of code it does not contain and cannot fix, and the failures move
  // whenever someone adds or removes a worktree. The worktree's own branch lints itself.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".worktrees/**"]),
]);
