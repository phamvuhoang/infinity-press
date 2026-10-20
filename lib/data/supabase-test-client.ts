import { vi, type Mock } from "vitest";

// A Supabase query builder stand-in for DAL unit tests: every builder method returns the same
// object, and awaiting it resolves to the configured { data, error }. Tests assert on the calls
// that matter (table, RPC name, arguments) instead of re-describing PostgREST's chain shape.
export function chainResult(result: { data: unknown; error: unknown }): unknown {
  const target = {};
  const proxy: unknown = new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return () => proxy;
    },
  });
  return proxy;
}

export function fakeSupabaseClient(options: {
  tables?: Record<string, { data: unknown; error: unknown }>;
  rpc?: { data: unknown; error: unknown };
}): { client: unknown; from: Mock; rpc: Mock } {
  const from = vi.fn((table: string) => chainResult(options.tables?.[table] ?? { data: null, error: null }));
  const rpc = vi.fn(() => Promise.resolve(options.rpc ?? { data: null, error: null }));
  return { client: { from, rpc }, from, rpc };
}

// Like chainResult, but records each builder call, so a test can assert on a security-relevant filter
// such as .eq("profile_id", ...).
// Pass `sink` to accumulate SEVERAL chains' calls into one array - a caller recording per table
// needs that, because a second query to the same table must add to the record rather than replace
// it. Without it an assertion that sweeps every recorded call silently stops covering the earlier
// queries.
export function recordingChain(
  result: { data: unknown; error: unknown },
  sink?: [string, unknown[]][],
): { chain: unknown; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = sink ?? [];
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          calls.push([String(property), args]);
          return proxy;
        };
      },
    },
  );
  return { chain: proxy, calls };
}
