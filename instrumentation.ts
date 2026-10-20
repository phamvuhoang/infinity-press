export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { parseServerEnv } = await import("@/lib/config/server-env-schema");
    // Fail at startup rather than on the first privileged request.
    parseServerEnv(process.env);
  }
}
