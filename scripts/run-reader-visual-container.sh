#!/usr/bin/env bash
set -euo pipefail

for name in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY SUPABASE_SERVICE_ROLE_KEY E2E_MAILPIT_URL E2E_DATABASE_URL; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required local visual-test variable: $name" >&2
    exit 1
  fi
done

# Discovery never launches a browser. Keep `--list` inside the same opt-in contract without paying
# for (or depending on) a remote renderer that cannot affect the discovered test set.
for argument in "$@"; do
  if [[ "$argument" == "--list" ]]; then
    E2E_VISUAL_PLATFORM=ubuntu-24.04-playwright-1.63.0-chromium-1243 \
    E2E_VISUAL_ARCH=amd64 \
    npm exec --yes --package=node@22.23.2 -- node node_modules/playwright/cli.js test \
      e2e/reader-depth-visual.spec.ts --project=chromium "$@"
    exit
  fi
done

visual_arch="amd64"
container_platform="linux/amd64"
image="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7"
container_name="infinity-books-reader-visual-$$"
visual_api_port="$(node -e 'process.stdout.write(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).port)')"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Only Chromium runs in the pinned Linux image. The test runner, fixture processor, and Next.js
# server remain native so ARM contributors do not execute esbuild through qemu; pixels and fonts
# still come exclusively from the same amd64 browser image used by CI.
docker run --rm --detach \
  --name "$container_name" \
  --platform "$container_platform" \
  --ipc host \
  --publish 127.0.0.1:3001:3001 \
  --add-host host.docker.internal:host-gateway \
  --env "VISUAL_API_PORT=$visual_api_port" \
  --mount "type=bind,source=$PWD,target=/work,readonly" \
  "$image" \
  bash -lc '
    test "$(uname -m)" = "x86_64"
    test "$(fc-match -f "%{family}\n" serif | head -n 1)" = "WenQuanYi Zen Hei,文泉驛正黑,文泉驛正黑"
    test "$(fc-match -f "%{family}\n" sans-serif | head -n 1)" = "WenQuanYi Zen Hei,文泉驛正黑,文泉驛正黑"
    node -e '\''
      const net = require("node:net");
      for (const port of [3000, Number(process.env.VISUAL_API_PORT)]) {
        net.createServer((incoming) => {
          const outgoing = net.connect(port, "host.docker.internal");
          incoming.pipe(outgoing).pipe(incoming);
          outgoing.on("error", () => incoming.destroy());
        }).listen(port, "127.0.0.1");
      }
    '\'' &
    node /work/node_modules/playwright/cli.js run-server --host 0.0.0.0 --port 3001
  ' >/dev/null

if ! node -e '
  const net = require("node:net");
  const deadline = Date.now() + 30000;
  const connect = () => {
    const socket = net.connect(3001, "127.0.0.1", () => { socket.end(); process.exit(0); });
    socket.on("error", () => {
      socket.destroy();
      if (Date.now() >= deadline) process.exit(1);
      setTimeout(connect, 250);
    });
  };
  connect();
'; then
  docker logs "$container_name" >&2
  exit 1
fi

PW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:3001/ \
E2E_VISUAL_PLATFORM=ubuntu-24.04-playwright-1.63.0-chromium-1243 \
E2E_VISUAL_ARCH="$visual_arch" \
E2E_HOST_PATH="$PATH" \
npm exec --yes --package=node@22.23.2 -- node node_modules/playwright/cli.js test \
  e2e/reader-depth-visual.spec.ts --project=chromium "$@"
