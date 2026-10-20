// Ruling CI: a missing E2E environment must make the run FAIL, never quietly shrink it.
//
// What this replaces, and why it matters more than it looks. `playwright.config.ts` supplies
// `webServer.env`, which reaches the SPAWNED SERVER ONLY - never the test runner's own process.
// So a bare `npm run test:e2e` with no environment used to start a perfectly healthy-looking
// server while the runner itself had no Supabase credentials, and the specs' own
// `test.skip(!hasRealSupabaseStack)` guards then skipped themselves: 7 of 20 specs ran, 13
// silently vanished, and the command exited 0. A green tick meant "most of the suite did not
// run", which is worse than a red one.
//
// CI never noticed because it writes real credentials into `$GITHUB_ENV` before invoking
// Playwright, so the runner there always had them - the failure mode existed only where nobody
// was looking, which is exactly why it survived.
//
// This is called at CONFIG LOAD time rather than from `globalSetup`, deliberately: config
// evaluation is the first thing Playwright does, so the check lands before the web server is
// spawned and before any worker starts. A `globalSetup` hook would leave the ordering against
// `webServer` a matter of Playwright's internals rather than something this repo controls.

// Every variable the suite genuinely needs, with the reason it is needed - so a failure tells an
// operator what to start, not merely what to export.
const required: { name: string; why: string }[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", why: "the app and the fixtures both talk to this stack" },
  { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", why: "the browser client signs in with it" },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    why: "fixtures create confirmed users, grant roles, and seed publications",
  },
  {
    name: "E2E_MAILPIT_URL",
    why: "the magic-link and password-recovery specs read their emails out of Mailpit",
  },
  {
    name: "E2E_DATABASE_URL",
    why: "the operations spec seeds a failed outbox row, which only the table owner can write",
  },
];

export function requireE2EEnvironment(): void {
  const missing = required.filter(({ name }) => !process.env[name]);
  if (missing.length === 0) return;

  const lines = missing.map(({ name, why }) => `  - ${name}: ${why}`).join("\n");
  throw new Error(
    `The Playwright suite needs a local Supabase stack, and these variables are not set:\n${lines}\n\n` +
      `Start one and export its values, for example:\n` +
      `  supabase start\n` +
      `  eval "$(supabase status -o env)"\n` +
      `  export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \\\n` +
      `         NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \\\n` +
      `         SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \\\n` +
      `         E2E_MAILPIT_URL="$MAILPIT_URL" \\\n` +
      `         E2E_DATABASE_URL="$DB_URL"\n\n` +
      `This suite refuses to run a subset of itself: skipping the specs that need a stack is how ` +
      `a run covering 7 of 20 specs used to report success.`,
  );
}
