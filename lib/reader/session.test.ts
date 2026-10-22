// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import {
  authorizeReaderSession,
  createReaderSession,
  normalizeResourceHref,
  ReaderAccessDeniedError,
  ReaderUnavailableError,
  resolveEntitledManifest,
  resolveEntitledResource,
  resolveSampleManifest,
  resolveSamplePublication,
  resolveSampleResource,
  sampleAllows,
} from "@/lib/reader/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const publicationId = "c0000000-0000-0000-0000-000000000001";
const otherPublicationId = "c0000000-0000-0000-0000-000000000002";
const sessionId = "d0000000-0000-0000-0000-000000000001";
const profileId = "20000000-0000-0000-0000-000000000001";

// Mirrors lib/access/grant.test.ts's rpcClient: `.rpc(name, args)` resolves once with
// {data, error}. The reader-session RPCs are the only thing the user-session client is ever
// asked to do here - every table read on the entitled path is service-role, after authorization.
function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(result) } as unknown as Awaited<ReturnType<typeof createClient>>;
}

// A service-role client whose `.from(table)` returns a thenable builder chain matching what the
// resource/sample lookups actually await: select().eq().eq().maybeSingle(). `rowsByTable` maps a
// table name to the single row (or null) that table's query resolves to.
// Every `.eq()` any lookup applies, recorded as {table, field, value}. This is what lets a test
// prove a query was actually scoped to the publication in the URL, rather than merely trusting
// that it was - the difference between "the resolver returned nothing" and "the resolver could
// not have returned another publication's row in the first place".
let recordedFilters: { table: string; field: string; value: unknown }[] = [];

function adminClient(
  rowsByTable: Record<string, unknown>,
  download?: ReturnType<typeof vi.fn>,
  // Per-table query faults, for the Ruling CF tests: a table named here resolves
  // `{ data: null, error }` instead of its row, so a test can fault exactly one query and leave
  // the rest of the fixture intact.
  errorsByTable: Record<string, { message: string }> = {},
) {
  // Every sample and entitled resolver now loads the publication first (fix round 1, Critical 1),
  // so a servable one is the default and each test states only what it is actually about. A test
  // that cares about publication state passes its own `ebook_publications` row - including `null`,
  // since the spread lets an explicit value win over this default.
  const rows: Record<string, unknown> = {
    ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status: "published" },
    // The sample paths also ask which edition this publication is active for, then whether
    // edition_is_sellable accepts it. `edition_is_sellable` here is the RPC's result, not a table.
    editions: { id: "edition-1", active_publication_id: publicationId, status: "published", books: { status: "published" } },
    edition_is_sellable: true,
    ...rowsByTable,
  };

  const from = vi.fn((table: string) => {
    const tableError = errorsByTable[table] ?? null;
    const result = Promise.resolve({
      data: tableError ? null : (rows[table] ?? null),
      error: tableError,
    });
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (field: string, value: unknown) => {
        recordedFilters.push({ table, field, value });
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => result,
      single: () => result,
      then: (...args: unknown[]) => (result as unknown as { then: (...a: unknown[]) => unknown }).then(...args),
    };
    return builder;
  });

  const rpc = vi.fn((name: string) =>
    Promise.resolve({ data: name in rows ? rows[name] : null, error: null }),
  );

  return {
    from,
    rpc,
    storage: { from: vi.fn(() => ({ download: download ?? vi.fn() })) },
  } as unknown as ReturnType<typeof createAdminClient>;
}

// A thin name for the same admin-client stub the rest of this file already uses: each table named
// resolves to the one row (or null) given, and an explicit `null` wins over the servable-publication
// default the same way it does everywhere else in this file.
function mockAdminTables(rowsByTable: Record<string, unknown>) {
  vi.mocked(createAdminClient).mockReturnValue(adminClient(rowsByTable));
}

beforeEach(() => {
  // Ruling CG: implementations and return values, not just call records. Must run before the
  // defaults below.
  vi.resetAllMocks();
  recordedFilters = [];
  vi.mocked(getServerEnv).mockReturnValue({
    readerSessionTtlSeconds: 900,
  } as unknown as ReturnType<typeof getServerEnv>);
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user-1" } as unknown as Awaited<
    ReturnType<typeof getSessionUser>
  >);
});

describe("createReaderSession", () => {
  // The plan's interface line reads `createReaderSession(profileId, publicationId)`, but Ruling AO
  // is explicit that a customer-facing mutation must derive the profile from auth.uid() and never
  // accept a caller-supplied profile id. This function is reachable from a Route Handler, so a
  // profileId parameter would be a straightforward IDOR primitive: mint a session against someone
  // else's profile. The signature deliberately takes only the publication id.
  it("never accepts a caller-supplied profile id and asks the RPC only for the publication", async () => {
    const client = rpcClient({
      data: [{ id: sessionId, publication_version: 3, expires_at: "2026-09-12T10:15:00.000Z" }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const grant = await createReaderSession(publicationId);

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("create_reader_session", {
      p_publication_id: publicationId,
      p_ttl_seconds: 900,
    });
    expect(grant).toEqual({
      sessionId,
      publicationId,
      publicationVersion: 3,
      expiresAt: "2026-09-12T10:15:00.000Z",
    });
  });

  // Session lifetime is server-derived: the TTL comes from the validated environment
  // (READER_SESSION_TTL_SECONDS, bounded 60-3600 by lib/config/server-env-schema.ts), never from
  // a request body or a caller argument. There is no parameter a client could reach.
  it("derives expiry from configuration rather than any caller-supplied duration", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ readerSessionTtlSeconds: 120 } as unknown as ReturnType<
      typeof getServerEnv
    >);
    const client = rpcClient({
      data: [{ id: sessionId, publication_version: 1, expires_at: "2026-09-12T10:02:00.000Z" }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client);

    await createReaderSession(publicationId);

    expect(client.rpc).toHaveBeenCalledWith("create_reader_session", {
      p_publication_id: publicationId,
      p_ttl_seconds: 120,
    });
  });

  it("denies an anonymous caller without constructing any Supabase client", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await expect(createReaderSession(publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // A reader with no entitlement, a revoked entitlement, or a publication that is not the book's
  // active published one all raise the same EB008 from the RPC, and all surface as one opaque
  // denial - the caller cannot tell which of those it was, so none of them confirms the
  // publication exists.
  it.each(["EB008", "P0002"])("maps %s to an opaque denial that names nothing", async (code) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "boom" } }));

    const error = await createReaderSession(publicationId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReaderAccessDeniedError);
    expect((error as Error).message).not.toContain("boom");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("never leaks a raw Postgres message for an unrecognized failure", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "XX000", message: "relation reader_sessions does not exist" } }),
    );

    const error = await createReaderSession(publicationId).catch((caught: unknown) => caught);

    expect((error as Error).message).not.toContain("reader_sessions");
  });
});

describe("authorizeReaderSession", () => {
  // The composite FK ties a session to (publication_id, publication_version), and a superseded
  // publication keeps its identity - so a session can outlive the publication's activity. Every
  // request re-runs the whole check (expiry, revocation, entitlement, status, version), which is
  // why this is a per-request RPC rather than something resolved once at creation.
  it("rechecks the session against the requested publication on every call", async () => {
    const client = rpcClient({
      data: [{ profile_id: profileId, publication_id: publicationId, publication_version: 2 }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const context = await authorizeReaderSession(sessionId, publicationId);

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("authorize_reader_session", {
      p_session_id: sessionId,
      p_publication_id: publicationId,
    });
    expect(context).toEqual({ profileId, publicationId, publicationVersion: 2 });
  });

  // Scoping proof: a session minted for one publication must not authorize another. The RPC is
  // asked about the pair, and a null result - which is what a cross-publication session produces -
  // is a denial, never a fallback to "the session's own publication".
  it("denies a session presented against a different publication", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: [], error: null }));

    await expect(authorizeReaderSession(sessionId, otherPublicationId)).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // One case, not three. This previously ran the same empty-array input under three names
  // ("expired", "revoked", "entitlement revoked"), which inflated the count without testing three
  // things: the RPC returns zero rows for every refusal, so from here they are indistinguishable
  // by construction. Which of those six conditions actually produced the empty result is a
  // property of authorize_reader_session, and it is genuinely covered there - pgTAP 009 mutates
  // state between minting and use to prove each one separately.
  it("denies a refusal reported as zero rows, without constructing the service-role client", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: [], error: null }));

    await expect(authorizeReaderSession(sessionId, publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("denies an anonymous caller before any client is built", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await expect(authorizeReaderSession(sessionId, publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("normalizeResourceHref", () => {
  it("joins ordinary catch-all segments into one in-publication path", () => {
    expect(normalizeResourceHref(["OEBPS", "text", "chapter1.xhtml"])).toBe("OEBPS/text/chapter1.xhtml");
  });

  // Task 1's review, Minor 5: isReaderLocator deliberately does not path-check href, and its doc
  // comment says so - rejecting traversal is this function's job. None of these may ever be
  // joined onto a storage prefix.
  it.each([
    [".. segment", ["OEBPS", "..", "..", "etc", "passwd"]],
    ["percent-encoded ..", ["OEBPS", "%2e%2e", "secret.xhtml"]],
    ["absolute path", ["", "etc", "passwd"]],
    ["empty segment", ["OEBPS", "", "chapter1.xhtml"]],
    ["single dot", ["OEBPS", ".", "chapter1.xhtml"]],
    ["backslash traversal", ["OEBPS", "..\\..\\secret.xhtml"]],
    ["space", ["OEBPS", "chapter1.xhtml .png"]],
    // These two were previously ONE case carrying a literal NUL byte in the source: invisible
    // on screen, mistakable for a space, and the reason grep classified this file as binary.
    // String.fromCharCode keeps the same coverage in plain ASCII.
    ["control character (NUL)", ["OEBPS", "chapter1" + String.fromCharCode(0) + ".xhtml"]],
    ["newline", ["OEBPS", "chapter1" + String.fromCharCode(10) + "chapter2.xhtml"]],
    ["windows drive", ["C:", "secret.xhtml"]],
    ["no segments", []],
  ])("rejects %s", (_case, segments) => {
    expect(normalizeResourceHref(segments)).toBeNull();
  });
});

describe("resolveEntitledResource", () => {
  // Ruling AM's property, third instance: the storage key is resolved from ebook_resources by
  // (publication_id, href) and never built from the request. A row that does not exist for this
  // publication is refused before any storage read.
  it("returns only the storage key the resource row carries", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        ebook_resources: { storage_key: "edition/asset/OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml" },
      }),
    );

    const resource = await resolveEntitledResource(publicationId, "OEBPS/text/chapter1.xhtml");

    expect(resource).toEqual({
      storageKey: "edition/asset/OEBPS/text/chapter1.xhtml",
      mediaType: "application/xhtml+xml",
    });
  });

  it("refuses an href with no row for this publication", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ ebook_resources: null }));

    await expect(resolveEntitledResource(publicationId, "OEBPS/text/nope.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });
});

describe("resolveSampleResource", () => {
  // Ruling AR: the allowlist is what authorizes the read. A resource absent from
  // book_samples.allowed_hrefs is refused even when its ebook_resources row plainly exists, and
  // the refusal is the same one a nonexistent href gets.
  it("serves an href only when the allowlist and the resource row agree it is a sample", async () => {
    const download = vi.fn();
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(
        {
          book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
          ebook_resources: {
            storage_key: "edition/asset/OEBPS/text/chapter1.xhtml",
            media_type: "application/xhtml+xml",
            access_class: "sample",
          },
        },
        download,
      ),
    );

    const resource = await resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml");

    expect(resource).toEqual({
      storageKey: "edition/asset/OEBPS/text/chapter1.xhtml",
      mediaType: "application/xhtml+xml",
    });
  });

  // The negative test Ruling AR names explicitly: a paid href refused through the sample route.
  it("refuses a paid href whose resource row exists but is not in the allowlist", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        ebook_resources: {
          storage_key: "edition/asset/OEBPS/text/chapter9.xhtml",
          media_type: "application/xhtml+xml",
          access_class: "paid",
        },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });

  // Belt and braces on the two sources of one truth Task 1's review flagged: an href the
  // allowlist names but whose row is `paid` must still be refused. The allowlist alone is not
  // enough; the row's own access_class has to agree.
  it("refuses an allowlisted href whose row is still marked paid", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter9.xhtml"] },
        ebook_resources: {
          storage_key: "edition/asset/OEBPS/text/chapter9.xhtml",
          media_type: "application/xhtml+xml",
          access_class: "paid",
        },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });

  // A href that is a perfectly legitimate sample of some OTHER publication must not be servable
  // under this one. The mock is deliberately generous - it would hand back a sample-class
  // resource row if the lookup ever reached it - so the only thing that can refuse this request
  // is the allowlist scoping, which is precisely the boundary under test.
  it("refuses a sample href belonging to a different publication", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        ebook_resources: {
          storage_key: "other-edition/other-asset/OTHER/intro.xhtml",
          media_type: "application/xhtml+xml",
          access_class: "sample",
        },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OTHER/intro.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });

  // Traces what the request can influence: both lookups are scoped to the publication from the
  // URL, so neither the allowlist nor the resource row can come from another publication even if
  // the href string happens to exist in both.
  it("scopes both the allowlist and the resource lookup to the requested publication", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        ebook_resources: {
          storage_key: "ed/asset/OEBPS/text/chapter1.xhtml",
          media_type: "application/xhtml+xml",
          access_class: "sample",
        },
      }),
    );

    await resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml");

    expect(recordedFilters).toContainEqual({
      table: "book_samples",
      field: "publication_id",
      value: publicationId,
    });
    expect(recordedFilters).toContainEqual({
      table: "ebook_resources",
      field: "publication_id",
      value: publicationId,
    });
  });

  it("refuses every href when the publication has no allowlist at all", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ book_samples: null }));

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });

  // Never gated on a session (Ruling AR): an anonymous visitor is the expected caller, so the
  // absence of a user must not change the outcome.
  it("serves an anonymous caller, because samples take no user gate", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        ebook_resources: {
          storage_key: "edition/asset/OEBPS/text/chapter1.xhtml",
          media_type: "application/xhtml+xml",
          access_class: "sample",
        },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml")).resolves.toMatchObject({
      mediaType: "application/xhtml+xml",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  // Fix round 1, Critical 1. The allowlist and access_class are not the whole boundary: the
  // publication's own state is part of it too. complete_processing_job writes the publication,
  // its resources, and its allowlist in one transaction, and no transition ever deletes them - so
  // without this check the anonymous route serves sample bytes for a publication that is awaiting
  // review, was explicitly rejected, or has been superseded, permanently.
  //
  // The superseded case needs no secret to exploit: that publication id was handed to every
  // anonymous visitor inside its own sample manifest links while it was live.
  it.each(["superseded", "rejected", "ready_for_preview"])(
    "refuses a sample resource for a %s publication",
    async (status) => {
      vi.mocked(createAdminClient).mockReturnValue(
        adminClient({
          ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status },
          book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
          ebook_resources: {
            storage_key: "edition/asset/OEBPS/text/chapter1.xhtml",
            media_type: "application/xhtml+xml",
            access_class: "sample",
          },
        }),
      );

      await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml")).rejects.toBeInstanceOf(
        ReaderAccessDeniedError,
      );
    },
  );

  it("refuses a sample resource when the publication row does not exist at all", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        ebook_publications: null,
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        ebook_resources: {
          storage_key: "edition/asset/OEBPS/text/chapter1.xhtml",
          media_type: "application/xhtml+xml",
          access_class: "sample",
        },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });
});

describe("resolveSamplePublication", () => {
  it("returns the EDITION's active publication when it is published and has a sample", async () => {
    mockAdminTables({
      editions: { active_publication_id: "pub-1", status: "published", books: { status: "published" } },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: { allowed_hrefs: ["OEBPS/c1.xhtml"] },
    });

    await expect(resolveSamplePublication("edition-1")).resolves.toEqual({ publicationId: "pub-1", sampleFull: false });
  });

  // Each of these is a separate reason, and all of them answer null. The page turns null into one
  // notFound(), so a draft book and a missing one are indistinguishable from outside - the same
  // non-disclosure rule the rest of this module enforces.
  it("returns null when the work is not published", async () => {
    mockAdminTables({ editions: { active_publication_id: "pub-1", status: "published", books: { status: "draft" } } });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });

  it("returns null when the edition has no active publication", async () => {
    mockAdminTables({ editions: { active_publication_id: null, status: "published", books: { status: "published" } } });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });

  it("returns null when the active publication is not published", async () => {
    mockAdminTables({
      editions: { active_publication_id: "pub-1", status: "published", books: { status: "published" } },
      ebook_publications: { id: "pub-1", status: "superseded" },
    });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });

  it("returns null when the sample allowlist is empty", async () => {
    mockAdminTables({
      editions: { active_publication_id: "pub-1", status: "published", books: { status: "published" } },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: { allowed_hrefs: [] },
    });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });

  it("returns null when there is no sample row at all", async () => {
    mockAdminTables({
      editions: { active_publication_id: "pub-1", status: "published", books: { status: "published" } },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: null,
    });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });

  it("returns null when the edition itself is not published, even with a live publication", async () => {
    mockAdminTables({
      editions: { active_publication_id: "pub-1", status: "archived", books: { status: "published" } },
      ebook_publications: { id: "pub-1", status: "published" },
      book_samples: { allowed_hrefs: ["OEBPS/c1.xhtml"] },
    });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });
});

describe("resolveSampleManifest", () => {
  // A helper for the toc cases below: one publication whose only servable resource is chapter1.
  function sampleManifestClient(storedToc: unknown[], readingOrder?: unknown[]) {
    const manifest = {
      metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: ["Author"] },
      readingOrder: readingOrder ?? [
        { href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" },
        { href: "OEBPS/text/chapter2.xhtml", mediaType: "application/xhtml+xml" },
      ],
      toc: storedToc,
    };
    return adminClient(
      {
        ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status: "published" },
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        // Both sources of the one truth must agree before an href is servable, so the sample set
        // is the intersection of the allowlist with the rows that call themselves samples.
        ebook_resources: [
          { href: "OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml", access_class: "sample" },
        ],
      },
      vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(manifest)]), error: null }),
    );
  }

  // The sample manifest is a function of the allowlist, not the entitled manifest with entries
  // filtered out. The toc is included but filtered to the same servable set: every href it names
  // is already disclosed by readingOrder, so it adds nothing to subtract - while a paid chapter's
  // href and its title both stay out entirely.
  it("lists only allowlisted reading-order entries and a toc filtered to the same set", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      sampleManifestClient([
        { title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml", children: [] },
        { title: "Chapter 2", href: "OEBPS/text/chapter2.xhtml", children: [] },
      ]),
    );

    const result = await resolveSampleManifest(publicationId);
    const serialized = JSON.stringify(result);

    expect(result.readingOrder).toEqual([
      { href: "/api/samples/" + publicationId + "/resources/OEBPS/text/chapter1.xhtml", type: "application/xhtml+xml" },
    ]);
    expect(result.toc).toEqual([
      {
        title: "Chapter 1",
        href: "/api/samples/" + publicationId + "/resources/OEBPS/text/chapter1.xhtml",
        children: [],
      },
    ]);
    // Neither the paid chapter's href nor its title survives.
    expect(serialized).not.toContain("chapter2");
    expect(serialized).not.toContain("Chapter 2");
  });

  // The one genuine leak vector in a filtered toc: retaining a non-servable ancestor purely to
  // preserve hierarchy would publish a paid section's title, and titles appear nowhere else in
  // the sample manifest. The parent is dropped and its servable child promoted instead.
  it("drops a paid ancestor and promotes its servable child rather than publishing the paid title", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      sampleManifestClient([
        {
          title: "Part II: The Hidden Doctrine",
          href: "OEBPS/text/part2.xhtml",
          children: [{ title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml", children: [] }],
        },
      ]),
    );

    const result = await resolveSampleManifest(publicationId);
    const serialized = JSON.stringify(result);

    expect(result.toc).toEqual([
      {
        title: "Chapter 1",
        href: "/api/samples/" + publicationId + "/resources/OEBPS/text/chapter1.xhtml",
        children: [],
      },
    ]);
    expect(serialized).not.toContain("Hidden Doctrine");
    expect(serialized).not.toContain("part2");
  });

  // lib/epub/parse.ts resolves a nav href's path and re-attaches its fragment, so most real TOC
  // entries look like `chapter1.xhtml#top`. Membership is tested against the path alone -
  // comparing the whole string would drop every fragment-bearing entry as "not a sample".
  it("matches a fragment-bearing toc href by path and keeps the fragment on the link", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      sampleManifestClient([{ title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml#top", children: [] }]),
    );

    const result = await resolveSampleManifest(publicationId);

    expect(result.toc).toEqual([
      {
        title: "Chapter 1",
        href: "/api/samples/" + publicationId + "/resources/OEBPS/text/chapter1.xhtml#top",
        children: [],
      },
    ]);
  });

  it("points reading-order links at the sample route, never at a storage object", async () => {
    const manifest = {
      metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: [] },
      readingOrder: [{ href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" }],
      toc: [],
    };
    const download = vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(manifest)]), error: null });
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(
        {
          ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status: "published" },
          book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
          ebook_resources: [
            { href: "OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml", access_class: "sample" },
          ],
        },
        download,
      ),
    );

    const serialized = JSON.stringify(await resolveSampleManifest(publicationId));

    expect(serialized).not.toContain("edition/asset");
    expect(serialized).not.toContain("supabase");
    expect(serialized).not.toContain("ebook-derived");
  });

  it("never exposes full-book positions or search text through the sample manifest", async () => {
    vi.mocked(createAdminClient).mockReturnValue(sampleManifestClient([]));

    const manifest = await resolveSampleManifest(publicationId);
    const serialized = JSON.stringify(manifest);

    expect(manifest).not.toHaveProperty("infinityBooks");
    expect(serialized).not.toContain("positions");
    expect(serialized).not.toContain("plain_text");
    expect(serialized).not.toContain("search_document");
  });

  // Ruling CH. The two hrefs are chosen so code-point and locale order genuinely disagree: "Z"
  // (U+005A) sorts before "a" (U+0061) by code point, while localeCompare in a typical locale
  // treats case as secondary and returns "a.css" first. So this test fails under localeCompare and
  // passes under the code-point comparator - which is exactly the platform-dependent difference
  // that could otherwise have first appeared on a CI runner with a different ICU build or LANG.
  //
  // It also removes the accident that hid the comparator entirely: until now no sample fixture
  // ever left two elements in `resources` by the time the sort ran.
  it("orders sample resources by code point, not by locale", async () => {
    const manifest = {
      metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: [] },
      readingOrder: [{ href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" }],
      toc: [],
    };
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(
        {
          book_samples: {
            allowed_hrefs: ["OEBPS/text/chapter1.xhtml", "OEBPS/styles/Z.css", "OEBPS/styles/a.css"],
          },
          ebook_resources: [
            { href: "OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml", access_class: "sample" },
            { href: "OEBPS/styles/a.css", media_type: "text/css", access_class: "sample" },
            { href: "OEBPS/styles/Z.css", media_type: "text/css", access_class: "sample" },
          ],
        },
        vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(manifest)]), error: null }),
      ),
    );

    const result = await resolveSampleManifest(publicationId);

    expect(result.resources).toEqual([
      { href: "/api/samples/" + publicationId + "/resources/OEBPS/styles/Z.css", type: "text/css" },
      { href: "/api/samples/" + publicationId + "/resources/OEBPS/styles/a.css", type: "text/css" },
    ]);
  });

  // Fix round 1, item 2. loadServablePublication already refused these, but nothing demanded it:
  // every fixture in this file hard-coded status "published", so the clause could be deleted with
  // the whole suite still green. These pin the guard on the manifest path, and their siblings in
  // the resolveSampleResource block pin the one Critical 1 adds.
  it.each(["ready_for_preview", "rejected", "superseded"])(
    "refuses a sample manifest for a %s publication",
    async (status) => {
      vi.mocked(createAdminClient).mockReturnValue(
        adminClient(
          {
            ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status },
            book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
            ebook_resources: [
              { href: "OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml", access_class: "sample" },
            ],
          },
          vi.fn(),
        ),
      );

      await expect(resolveSampleManifest(publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    },
  );
});

// Fix round 1, item 3. This resolver had no tests of any kind, which is exactly why it shipped a
// toc of raw in-publication hrefs: readingOrder and resources were rewritten, the toc was passed
// through verbatim, and nothing compared them.
describe("resolveEntitledManifest", () => {
  const storedManifest = {
    metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: ["Author"] },
    readingOrder: [
      { href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" },
      { href: "OEBPS/text/chapter2.xhtml", mediaType: "application/xhtml+xml" },
    ],
    toc: [
      {
        title: "Part I",
        href: "OEBPS/text/part1.xhtml",
        children: [{ title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml#top", children: [] }],
      },
      { title: "Chapter 2", href: "OEBPS/text/chapter2.xhtml", children: [] },
    ],
  };

  function entitledClient(rows?: Record<string, unknown>) {
    return adminClient(
      {
        ebook_resources: [
          { href: "OEBPS/styles/main.css", media_type: "text/css" },
          { href: "OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml" },
          { href: "OEBPS/text/chapter2.xhtml", media_type: "application/xhtml+xml" },
        ],
        ...rows,
      },
      vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(storedManifest)]), error: null }),
    );
  }

  const resourceUrl = (href: string) => `/api/reader/publications/${publicationId}/resources/${href}`;

  it("rewrites reading-order links to the authenticated route", async () => {
    vi.mocked(createAdminClient).mockReturnValue(entitledClient());

    const manifest = await resolveEntitledManifest(publicationId);

    expect(manifest.readingOrder).toEqual([
      { href: resourceUrl("OEBPS/text/chapter1.xhtml"), type: "application/xhtml+xml" },
      { href: resourceUrl("OEBPS/text/chapter2.xhtml"), type: "application/xhtml+xml" },
    ]);
  });

  it("projects validated stored positions into protected reader hrefs", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      entitledClient({
        ebook_publications: {
          id: publicationId,
          manifest_key: "edition/asset/manifest.json",
          status: "published",
          positions_json: [
            {
              href: "OEBPS/text/chapter1.xhtml",
              progression: 0.25,
              totalProgression: 0.1,
              locations: { position: 1 },
              text: { before: "before", highlight: "anchor", after: "after" },
            },
          ],
        },
      }),
    );

    const manifest = await resolveEntitledManifest(publicationId);

    expect(manifest.infinityBooks).toEqual({
      positions: [
        {
          href: resourceUrl("OEBPS/text/chapter1.xhtml"),
          progression: 0.25,
          totalProgression: 0.1,
          locations: { position: 1 },
          text: { before: "before", highlight: "anchor", after: "after" },
        },
      ],
    });
  });

  it.each([
    ["null", null],
    ["malformed", [{ href: "OEBPS/text/chapter1.xhtml", progression: "bad", locations: {} }]],
    ["non-spine", [{ href: "OEBPS/styles/main.css", progression: 0, totalProgression: null, locations: {} }]],
    [
      "oversized quote",
      [
        {
          href: "OEBPS/text/chapter1.xhtml",
          progression: 0,
          totalProgression: null,
          locations: {},
          text: { highlight: "x".repeat(161) },
        },
      ],
    ],
  ])("degrades a %s positions extension to null without blocking the manifest", async (_name, positions_json) => {
    vi.mocked(createAdminClient).mockReturnValue(
      entitledClient({
        ebook_publications: {
          id: publicationId,
          manifest_key: "edition/asset/manifest.json",
          status: "published",
          positions_json,
        },
      }),
    );

    await expect(resolveEntitledManifest(publicationId)).resolves.toMatchObject({
      infinityBooks: { positions: null },
    });
  });

  it("lists only the resources that are not already in the reading order", async () => {
    vi.mocked(createAdminClient).mockReturnValue(entitledClient());

    const manifest = await resolveEntitledManifest(publicationId);

    expect(manifest.resources).toEqual([{ href: resourceUrl("OEBPS/styles/main.css"), type: "text/css" }]);
  });

  // The bug this block exists for: a bare `OEBPS/text/chapter1.xhtml` in the toc is resolved by a
  // reader engine against the manifest URL, producing a request no route serves. The entitled toc
  // is NOT filtered - every chapter stays, including ones absent from the sample set - but each
  // href is rewritten, nesting is preserved, and a fragment survives on the rewritten link.
  it("rewrites toc hrefs without filtering the toc, preserving nesting and fragments", async () => {
    vi.mocked(createAdminClient).mockReturnValue(entitledClient());

    const manifest = await resolveEntitledManifest(publicationId);

    expect(manifest.toc).toEqual([
      {
        title: "Part I",
        href: resourceUrl("OEBPS/text/part1.xhtml"),
        children: [
          { title: "Chapter 1", href: resourceUrl("OEBPS/text/chapter1.xhtml") + "#top", children: [] },
        ],
      },
      { title: "Chapter 2", href: resourceUrl("OEBPS/text/chapter2.xhtml"), children: [] },
    ]);
  });

  it("never emits a storage key or a bare in-publication path", async () => {
    vi.mocked(createAdminClient).mockReturnValue(entitledClient());

    const serialized = JSON.stringify(await resolveEntitledManifest(publicationId));

    expect(serialized).not.toContain("edition/asset");
    expect(serialized).not.toContain("ebook-derived");
    // Every href in the document is an application route; none is a bare in-publication path.
    expect(serialized).not.toContain('"OEBPS/');
  });

  // authorize_reader_session has already decided this is the caller's readable publication, and an
  // edition with no active pointer keeps its latest superseded one readable
  // (reader_publication_for_edition, rule step 2). Sample manifests and resources stay published-only.
  it("serves an entitled manifest for a superseded publication", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      entitledClient({
        ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status: "superseded" },
      }),
    );

    await expect(resolveEntitledManifest(publicationId)).resolves.toMatchObject({
      readingOrder: [{ href: resourceUrl("OEBPS/text/chapter1.xhtml") }, { href: resourceUrl("OEBPS/text/chapter2.xhtml") }],
    });
  });

  it.each(["ready_for_preview", "rejected"])(
    "refuses an entitled manifest for a %s publication",
    async (status) => {
      vi.mocked(createAdminClient).mockReturnValue(
        entitledClient({
          ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status },
        }),
      );

      await expect(resolveEntitledManifest(publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    },
  );
});

// Ruling CF. Infrastructure failures must be distinguishable from authorization refusals, because
// a 404 is a status operators read as normal - it hid real incidents. Each case below faults
// exactly one query or one storage read and asserts the *infrastructure* error, and the split at
// loadServablePublication asserts the opposite direction just as hard: a missing row and a
// non-published status must STAY authorization refusals, or the Critical this task closed reopens.
describe("infrastructure failures are not authorization refusals (Ruling CF)", () => {
  const storedManifest = {
    metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: [] },
    readingOrder: [{ href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" }],
    toc: [],
  };

  const goodDownload = () =>
    vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(storedManifest)]), error: null });

  const sampleRows = [
    { href: "OEBPS/text/chapter1.xhtml", media_type: "application/xhtml+xml", access_class: "sample" },
  ];
  const allowlist = { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] };
  const sampleResourceRow = {
    storage_key: "edition/asset/OEBPS/text/chapter1.xhtml",
    media_type: "application/xhtml+xml",
    access_class: "sample",
  };

  // Site 1: loadServablePublication's query error. Reached by every resolver, so faulting it once
  // proves the split for all three entry points.
  it.each([
    ["resolveSampleResource", () => resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml")],
    ["resolveSampleManifest", () => resolveSampleManifest(publicationId)],
    ["resolveEntitledManifest", () => resolveEntitledManifest(publicationId)],
  ] as const)("reports a publication-query fault as unavailable, not denied (%s)", async (_name, invoke) => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({ book_samples: allowlist, ebook_resources: sampleRows }, goodDownload(), {
        ebook_publications: { message: "connection reset" },
      }),
    );

    await expect(invoke()).rejects.toBeInstanceOf(ReaderUnavailableError);
  });

  // The other half of the same split, and the more important half: these must NOT become 502.
  // "No such row" and "not published" are the existence facts the 404 model exists to hide.
  it("keeps a missing publication row an authorization refusal", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({ ebook_publications: null, book_samples: allowlist, ebook_resources: sampleResourceRow }),
    );

    const error = await resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReaderAccessDeniedError);
    expect(error).not.toBeInstanceOf(ReaderUnavailableError);
  });

  it.each(["ready_for_preview", "rejected", "superseded"])(
    "keeps a %s publication an authorization refusal",
    async (status) => {
      vi.mocked(createAdminClient).mockReturnValue(
        adminClient({
          ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status },
          book_samples: allowlist,
          ebook_resources: sampleResourceRow,
        }),
      );

      const error = await resolveSampleResource(publicationId, "OEBPS/text/chapter1.xhtml").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReaderAccessDeniedError);
      expect(error).not.toBeInstanceOf(ReaderUnavailableError);
    },
  );

  // Site 2: the manifest object cannot be downloaded.
  it("reports an unreadable manifest object as unavailable", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(
        { book_samples: allowlist, ebook_resources: sampleRows },
        vi.fn().mockResolvedValue({ data: null, error: { message: "storage down" } }),
      ),
    );

    await expect(resolveSampleManifest(publicationId)).rejects.toBeInstanceOf(ReaderUnavailableError);
  });

  // Site 3: the stored manifest is not valid JSON - a corrupt artefact, not a refusal.
  it("reports a corrupt stored manifest as unavailable", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient(
        { book_samples: allowlist, ebook_resources: sampleRows },
        vi.fn().mockResolvedValue({ data: new Blob(["this is not json"]), error: null }),
      ),
    );

    await expect(resolveSampleManifest(publicationId)).rejects.toBeInstanceOf(ReaderUnavailableError);
  });

  // Site 4: the entitled manifest's resource query.
  it("reports an entitled resource-query fault as unavailable", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({}, goodDownload(), { ebook_resources: { message: "deadlock detected" } }),
    );

    await expect(resolveEntitledManifest(publicationId)).rejects.toBeInstanceOf(ReaderUnavailableError);
  });

  // Site 5, the worst of them: this query's error was not destructured at all, so a fault produced
  // a structurally valid 200 with an empty readingOrder and resources. An anonymous visitor could
  // not tell "this book has no sample" from "the database is down". It must now fail closed.
  it("reports a sample resource-query fault as unavailable instead of returning an empty manifest", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({ book_samples: allowlist }, goodDownload(), {
        ebook_resources: { message: "deadlock detected" },
      }),
    );

    await expect(resolveSampleManifest(publicationId)).rejects.toBeInstanceOf(ReaderUnavailableError);
  });
});

describe("whole-book sample (allowed_hrefs contains \"*\")", () => {
  const xhtml = "application/xhtml+xml";
  const chapterRows = Array.from({ length: 9 }, (_, i) => ({
    href: `OEBPS/text/chapter${i + 1}.xhtml`,
    media_type: xhtml,
    access_class: i === 0 ? "sample" : "paid",
  }));

  function wholeBookManifestClient(allowedHrefs: unknown[], readingOrderHrefs: string[]) {
    const manifest = {
      metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: ["Author"] },
      readingOrder: readingOrderHrefs.map((href) => ({ href, mediaType: xhtml })),
      toc: readingOrderHrefs.map((href) => ({ title: href, href, children: [] })),
    };
    return adminClient(
      { book_samples: { allowed_hrefs: allowedHrefs }, ebook_resources: chapterRows },
      vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(manifest)]), error: null }),
    );
  }

  it("sampleAllows treats \"*\" as every href and otherwise needs an exact match", () => {
    expect(sampleAllows(["*"], "OEBPS/c9.xhtml")).toBe(true);
    expect(sampleAllows(["OEBPS/c1.xhtml", "*"], "OEBPS/c9.xhtml")).toBe(true);
    expect(sampleAllows(["OEBPS/c1.xhtml"], "OEBPS/c1.xhtml")).toBe(true);
    expect(sampleAllows(["OEBPS/c1.xhtml"], "OEBPS/c9.xhtml")).toBe(false);
    expect(sampleAllows([], "OEBPS/c1.xhtml")).toBe(false);
    expect(sampleAllows("*", "OEBPS/c1.xhtml")).toBe(false);
    expect(sampleAllows(null, "OEBPS/c1.xhtml")).toBe(false);
  });

  it("serves a paid chapter of this publication when the allowlist is [\"*\"]", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["*"] },
        ebook_resources: { storage_key: "edition/asset/OEBPS/text/chapter9.xhtml", media_type: xhtml, access_class: "paid" },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).resolves.toEqual({
      storageKey: "edition/asset/OEBPS/text/chapter9.xhtml",
      mediaType: xhtml,
    });
    // Still scoped to the requested publication: the wildcard opens this book, not any book.
    expect(recordedFilters).toContainEqual({ table: "ebook_resources", field: "publication_id", value: publicationId });
  });

  it("still refuses a paid chapter when the allowlist is the ordinary listed form", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        book_samples: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] },
        ebook_resources: { storage_key: "edition/asset/OEBPS/text/chapter9.xhtml", media_type: xhtml, access_class: "paid" },
      }),
    );

    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
  });

  it("lists every resource of the publication in the manifest when the allowlist is [\"*\"]", async () => {
    const hrefs = chapterRows.map((row) => row.href);
    vi.mocked(createAdminClient).mockReturnValue(wholeBookManifestClient(["*"], hrefs));

    const result = await resolveSampleManifest(publicationId);

    expect(result.readingOrder.map((link) => link.href)).toEqual(
      hrefs.map((href) => "/api/samples/" + publicationId + "/resources/" + href),
    );
    expect(result.toc).toHaveLength(9);
    // The wildcard query drops only the access_class filter, never the publication scope.
    expect(recordedFilters).toContainEqual({ table: "ebook_resources", field: "publication_id", value: publicationId });
    expect(recordedFilters).not.toContainEqual({ table: "ebook_resources", field: "access_class", value: "sample" });
  });

  // Review Focus 5. Every ebook_resources row is 'paid' or 'sample' (the table's CHECK), so the
  // wildcard deliberately opens 'paid'. What it must never open is anything that is not a resource
  // row of this publication: the stored manifest may name an href with no row (another
  // publication's file, the source EPUB), and the publication itself must still be servable.
  it("never widens beyond this publication's own resource rows or a servable publication", async () => {
    const ghost = "OEBPS/text/not-a-resource.xhtml";
    vi.mocked(createAdminClient).mockReturnValue(
      wholeBookManifestClient(["*"], ["OEBPS/text/chapter1.xhtml", ghost]),
    );
    const manifest = await resolveSampleManifest(publicationId);
    expect(JSON.stringify(manifest)).not.toContain("not-a-resource");

    // No row for this publication: the resource resolver refuses, wildcard or not.
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({ book_samples: { allowed_hrefs: ["*"] }, ebook_resources: null }),
    );
    await expect(resolveSampleResource(publicationId, ghost)).rejects.toBeInstanceOf(ReaderAccessDeniedError);

    // A publication that is not live: both resolvers refuse before the allowlist is consulted.
    for (const status of ["awaiting_review", "rejected"]) {
      vi.mocked(createAdminClient).mockReturnValue(
        adminClient({
          ebook_publications: { id: publicationId, manifest_key: "edition/asset/manifest.json", status },
          book_samples: { allowed_hrefs: ["*"] },
          ebook_resources: { storage_key: "k", media_type: xhtml, access_class: "paid" },
        }),
      );
      await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).rejects.toBeInstanceOf(
        ReaderAccessDeniedError,
      );
      await expect(resolveSampleManifest(publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    }
  });

  // Final review, finding 1: sample_chunk_locator requires edition_is_sellable, so the app-side
  // resolvers must too. A blocked edition (editorial_state = 'blocked') is not sellable.
  it("refuses a whole-book sample of an edition that is not sellable", async () => {
    const rows = {
      book_samples: { allowed_hrefs: ["*"] },
      ebook_resources: { storage_key: "edition/asset/OEBPS/text/chapter9.xhtml", media_type: xhtml, access_class: "paid" },
      edition_is_sellable: false,
    };
    vi.mocked(createAdminClient).mockReturnValue(adminClient(rows));
    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
    vi.mocked(createAdminClient).mockReturnValue(adminClient(rows));
    await expect(resolveSampleManifest(publicationId)).rejects.toBeInstanceOf(ReaderAccessDeniedError);
    mockAdminTables({
      editions: { active_publication_id: publicationId, status: "published", books: { status: "published" } },
      book_samples: { allowed_hrefs: ["*"] },
      edition_is_sellable: false,
    });
    await expect(resolveSamplePublication("edition-1")).resolves.toBeNull();
  });

  it("refuses a sample whose publication is no edition's active one", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminClient({
        editions: null,
        book_samples: { allowed_hrefs: ["*"] },
        ebook_resources: { storage_key: "k", media_type: xhtml, access_class: "paid" },
      }),
    );
    await expect(resolveSampleResource(publicationId, "OEBPS/text/chapter9.xhtml")).rejects.toBeInstanceOf(
      ReaderAccessDeniedError,
    );
    expect(recordedFilters).toContainEqual({ table: "editions", field: "active_publication_id", value: publicationId });
  });

  it("renders the sample page for a whole-book allowlist", async () => {
    mockAdminTables({
      editions: { active_publication_id: publicationId, status: "published", books: { status: "published" } },
      book_samples: { allowed_hrefs: ["*"] },
    });

    await expect(resolveSamplePublication("edition-1")).resolves.toEqual({ publicationId, sampleFull: true });
  });
});
