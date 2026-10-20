// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("ebook index-search CLI", () => {
  it("reports a missing publication argument with the stable index-search error shape", () => {
    const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/ebook.ts", "index-search"], {
      cwd: process.cwd(),
      encoding: "utf8",
      // Explicit empty values prevent process.loadEnvFile from importing developer/cloud credentials.
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ code: "INDEX_SEARCH_MISSING_PUBLICATION" });
  });

  it("reports an invalid publication identifier with a stable code before environment or storage IO", () => {
    const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/ebook.ts", "index-search", "--publication", "not-a-uuid"], {
      cwd: process.cwd(),
      encoding: "utf8",
      // Explicit empty values prevent process.loadEnvFile from importing developer/cloud credentials.
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ publicationId: "not-a-uuid", code: "INDEX_SEARCH_INVALID_PUBLICATION_ID" });
  });

  it("maps an unexpected index-search dependency failure to a stable code without its message", () => {
    const publicationId = "11111111-1111-4111-8111-111111111111";
    const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/ebook.ts", "index-search", "--publication", publicationId], {
      cwd: process.cwd(),
      encoding: "utf8",
      // Explicit empty values prevent process.loadEnvFile from importing developer/cloud credentials.
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ publicationId, code: "INDEX_SEARCH_UNEXPECTED" });
    expect(result.stderr).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
  });
});
