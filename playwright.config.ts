import { defineConfig, devices } from "@playwright/test";

import { requireE2EEnvironment } from "./e2e/support/required-env";
import {
  type BankTransferName,
  type ServerEnvironmentName,
  bankTransferDefaults,
  bankTransferValue,
  manualServerPort,
  manualServerUrl,
  type SepayName,
  sepayDefaults,
  sepayServerPort,
  sepayServerUrl,
  sepayValue,
  serverEnvironmentDefaults,
  serverEnvironmentValue,
  simulatorServerUrl,
} from "./e2e/support/server-env";

// A remote Playwright server contributes its Linux PATH to the connection. Visual runs still
// execute fixtures and the Next server on the host, so restore the captured host PATH before any
// worker or child process is created.
if (process.env.E2E_HOST_PATH) {
  process.env.PATH = process.env.E2E_HOST_PATH;
}

// Ruling CI: fail the run rather than shrink it. Called here, at config load, so it happens
// before the web server is spawned and before any worker starts - see e2e/support/required-env.ts
// for what this replaced and why a passing `npm run test:e2e` used to mean so little.
requireE2EEnvironment();

// The suite needs a real local Supabase stack, which the check above has already guaranteed. What
// remains is operational configuration with honest defaults - see e2e/support/server-env.ts, which
// specs also read so they present the same values the server holds.

const passthroughEnvironment = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

// Ruling CA: Firefox and WebKit run only on main-branch/nightly CI, never on a pull request. Keep
// the normal contributor/PR gate Chromium-only; the explicit matrix command and nightly job opt
// into the additional engines without multiplying every unrelated browser journey.
const browserMatrix = process.env.E2E_BROWSER_MATRIX === "all";

// The environment every spawned web server gets, plus whatever distinguishes one of them.
function webServerEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      (Object.keys(serverEnvironmentDefaults) as ServerEnvironmentName[]).map((name) => [
        name,
        serverEnvironmentValue(name),
      ]),
    ),
    ...Object.fromEntries(
      passthroughEnvironment.map((name) => [name, process.env[name] as string]),
    ),
    ...overrides,
  };
}

// S7. The manual bank-transfer journey needs PAYMENT_PROVIDER=manual, and a provider is a property
// of the running server, not of a test. So a second Next server runs on its own port with the
// manual environment, and one project - and only that project - points at it.
//
// PAYMENT_PROVIDER and SITE_URL are set AFTER the shared defaults rather than through
// serverEnvironmentValue(), deliberately: this server's identity must not be something a stray
// shell variable can change. A manual server that quietly came up as the simulator is the failure
// this whole arrangement exists to prevent.
const manualServerEnvironment = webServerEnvironment({
  PAYMENT_PROVIDER: "manual",
  SITE_URL: manualServerUrl,
  ...Object.fromEntries(
    (Object.keys(bankTransferDefaults) as BankTransferName[]).map((name) => [name, bankTransferValue(name)]),
  ),
});

// S18. The same arrangement for SePay: PAYMENT_PROVIDER=sepay with sandbox credentials. SePay
// itself is never contacted - the spec intercepts the browser's POST and plays SePay's part.
const sepayServerEnvironment = webServerEnvironment({
  PAYMENT_PROVIDER: "sepay",
  SITE_URL: sepayServerUrl,
  ...Object.fromEntries((Object.keys(sepayDefaults) as SepayName[]).map((name) => [name, sepayValue(name)])),
});

const sepaySpecs = ["**/sepay-payment.spec.ts"];
const sepayProject = "chromium-sepay";

// Every spec whose journey ends at the MANUAL provider. S9 adds the bundle purchase journey, whose
// exit criterion is an admin confirming a bank transfer for a multi-item order, so it belongs to
// the same project and the same server as the S7 spec rather than to a second arrangement.
const manualSpecs = ["**/manual-payment.spec.ts", "**/bundle-purchase.spec.ts"];
const visualSpec = "**/reader-depth-visual.spec.ts";
const manualProject = "chromium-manual";

// Playwright starts every `webServer` entry whatever `--project` selects, so an unconditional
// manual entry made EVERY invocation require port 3100 - including
// scripts/run-reader-visual-container.sh, which runs one spec under `--project=chromium` and would
// then fail for a reason that has nothing to do with pixels. Only a run that can actually collect
// a manual spec asks for that server.
//
// Reading argv is how a config learns the project selection; Playwright does not hand it over.
// `--project` is the only spelling (there is no short alias), and either form is accepted. With no
// selection at all every project runs, so the server is needed - which keeps
// `npx playwright test e2e/manual-payment.spec.ts` and a bare `npm run test:e2e` working as the
// runbook documents them.
function selectedProjects(argv: string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") {
      const value = argv[index + 1];
      if (value !== undefined) names.push(value);
    } else if (argument.startsWith("--project=")) {
      names.push(argument.slice("--project=".length));
    }
  }
  return names;
}

const selection = selectedProjects(process.argv.slice(2));
const manualServerNeeded = selection.length === 0 || selection.includes(manualProject);
const sepayServerNeeded = selection.length === 0 || selection.includes(sepayProject);

export default defineConfig({
  testDir: "./e2e",
  // Pixel assertions are meaningful only inside scripts/run-reader-visual-container.sh, which
  // supplies the pinned Linux browser/font/Node contract. Ordinary PR and check:full discovery
  // must not collect tests that intentionally reject their unpinned renderer.
  // The manual specs are excluded here, and re-admitted only by the chromium-manual project
  // below: a project inherits this list unless it declares its own. Discovering a manual spec in
  // a simulator project would run that journey against the simulator server.
  testIgnore: [...(process.env.E2E_VISUAL_PLATFORM ? [] : [visualSpec]), ...manualSpecs, ...sepaySpecs],
  fullyParallel: false,
  // Ruling BN. The fixtures create users, grant admin roles, publish books, and move one book's
  // active publication pointer - all against a single shared local stack with no teardown. Two
  // workers doing that concurrently interfere by construction, and `fullyParallel: false` alone
  // does not prevent it: that setting serializes tests within a file, while workers still run
  // separate FILES in parallel.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: simulatorServerUrl,
    trace: "retain-on-failure",
    ...(process.env.PW_TEST_CONNECT_WS_ENDPOINT
      ? { connectOptions: { wsEndpoint: process.env.PW_TEST_CONNECT_WS_ENDPOINT } }
      : {}),
  },
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: simulatorServerUrl } },
    ...(browserMatrix
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"], baseURL: simulatorServerUrl } },
          { name: "webkit", use: { ...devices["Desktop Safari"], baseURL: simulatorServerUrl } },
        ]
      : []),
    // S7, extended by S9. The only project that sees the manual specs, and the only one pointed
    // at the manual server. It declares its own testIgnore because the top-level list excludes
    // those specs from every other project; the visual spec stays out either way, since testMatch admits
    // nothing else. Chromium only: this journey exercises server behaviour, not a renderer, so the
    // browser matrix has nothing to add to it.
    {
      name: manualProject,
      testIgnore: [],
      testMatch: manualSpecs,
      use: { ...devices["Desktop Chrome"], baseURL: manualServerUrl },
    },
    // S18. The same arrangement as chromium-manual, for the SePay server.
    {
      name: sepayProject,
      testIgnore: [],
      testMatch: sepaySpecs,
      use: { ...devices["Desktop Chrome"], baseURL: sepayServerUrl },
    },
  ],
  // Playwright starts these in array order, each awaited before the next. That ordering is load
  // bearing: the first entry produces `.next`, and the second only starts a server from it. Two
  // concurrent `next build` runs writing one output directory corrupt it, so exactly one entry
  // builds.
  webServer: [
    {
      command: "npm run build && npm run start",
      url: simulatorServerUrl,
      reuseExistingServer: !process.env.CI,
      // Leave extra room for the first production build in a clean visual-test checkout.
      timeout: process.env.E2E_VISUAL_PLATFORM ? 600_000 : 180_000,
      env: webServerEnvironment(),
    },
    // Present only when the selected projects include the one pointed at it - see
    // manualServerNeeded above.
    ...(manualServerNeeded
      ? [
          {
            // Starts only - never builds. See the note above.
            command: `npm run start -- --port ${manualServerPort}`,
            url: manualServerUrl,
            // Never reused, on CI or off it. Reuse asks only "is something answering on this
            // port?", and a server answering on it that was started with
            // PAYMENT_PROVIDER=simulator - a leftover from another run, another worktree, a scratch
            // stack - would make this spec exercise the wrong provider. An occupied port is a loud
            // failure here rather than a quiet substitution; that is the same standard
            // e2e/support/required-env.ts holds, for the same reason.
            reuseExistingServer: false,
            timeout: 60_000,
            env: manualServerEnvironment,
          },
        ]
      : []),
    ...(sepayServerNeeded
      ? [
          {
            // Starts only - never builds. The first entry builds.
            command: `npm run start -- --port ${sepayServerPort}`,
            url: sepayServerUrl,
            reuseExistingServer: false,
            timeout: 60_000,
            env: sepayServerEnvironment,
          },
        ]
      : []),
  ],
});
