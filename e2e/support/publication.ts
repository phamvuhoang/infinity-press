import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { strToU8, zipSync, type Zippable } from "fflate";

import { seedCatalogBook } from "./catalog";
import { createAnonClient, createServiceRoleClient } from "./supabase";

// ================================================================================================
// The fixture EPUB
//
// Moved here verbatim from e2e/ebook-golden-path.spec.ts so that more than one spec can have a
// publication the engine can actually render. Nothing about the bytes changed in the move, and
// the golden path's own paging assertions are what prove that: they depend on the two-chapter
// asymmetry below and fail loudly if it drifts.
//
// Generated here rather than committed, and generated rather than taken from the private corpus:
// `.gitignore` ignores `*.epub` repository-wide, CI must never see copyrighted content, and
// `fixtures/epub/private/` is empty in every checkout. The text below is written for this test.
//
// Ruling CM - THE SVG TRAP. There is deliberately no `image/svg+xml` anywhere in this fixture.
// The processor rejects a publication OUTRIGHT if its manifest declares even one SVG item
// (lib/epub/process.ts's DEFAULT_ALLOWED_MEDIA_TYPES excludes it, and buildResource throws
// UNSUPPORTED_MEDIA on the first offender rather than degrading per resource). SVG cover wrappers
// are common in real EPUBs, so a fixture that grew one would fail here as a processor-profile
// rejection wearing the costume of a reader bug. The cover is JPEG for exactly this reason.
//
// Written out longhand instead of reusing scripts/fixtures/create-test-epub.ts: that module is
// vitest fixture infrastructure built around one-thing-deliberately-wrong variants, whereas this
// needs two chapters of real prose so that turning a page genuinely changes the rendered
// resource - which is the whole point of the navigate-save-reload assertion in the golden path.
export const CHAPTER_ONE_MARKER = "The lamplighter had already begun his rounds";
export const CHAPTER_TWO_MARKER = "Morning came grey over the harbour wall";
// Only present in the variants that carry a short chapter - see buildFixtureEpub's options.
export const CHAPTER_THREE_MARKER = "And that was the whole of it";
export const READER_DEPTH_SELECTION = "The brass compass pointed toward the quiet northern pier.";
export const READER_DEPTH_IDENTICAL = "the lantern answered twice";
export const READER_DEPTH_EARLY_CONTEXT = "EARLY PASSAGE";
export const READER_DEPTH_LATE_CONTEXT = "LATER PASSAGE";
export const READER_DEPTH_VIETNAMESE = "Hành trình qua cửa biển bắt đầu bằng một tách cà phê sữa đá.";
export const READER_DEPTH_LONG_CHUNK_TERM = "Measured intervening phrase 155";
export const READER_DEPTH_LONG_QUOTE = Array.from({ length: 320 }, () => "🌊").join("");

// The hrefs the processor emits for the fixture, named once so the seeding below and the specs
// that probe the sample boundary agree about them.
export const CHAPTER_ONE_HREF = "OEBPS/text/chapter1.xhtml";
export const CHAPTER_TWO_HREF = "OEBPS/text/chapter2.xhtml";
export const CHAPTER_THREE_HREF = "OEBPS/text/chapter3.xhtml";
export const STYLESHEET_HREF = "OEBPS/styles/style.css";

function chapter(title: string, opening: string, paragraphs: number, depthFixture = false): string {
  const body = Array.from(
    { length: paragraphs },
    (_, index) =>
      `<p>${index === 0 ? opening : `Paragraph ${index + 1} of ${title}.`} ` +
      "She walked on, past the shuttered stalls and the smell of tar and rope, counting the " +
      "windows that still held a light. The town kept its own hours and told no one what they " +
      "were.</p>",
  ).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title><link rel="stylesheet" href="../styles/style.css" type="text/css"/></head>
<body>
<h1>${title}</h1>
${depthFixture ? `<p id="depth-selection">${READER_DEPTH_SELECTION}</p>
<p id="depth-long-quote">${READER_DEPTH_LONG_QUOTE}</p>
<p id="depth-identical">${READER_DEPTH_IDENTICAL} <span id="depth-early-context">${READER_DEPTH_EARLY_CONTEXT}</span>. ${Array.from({ length: 180 }, (_, index) => `Measured intervening phrase ${index + 1}.`).join(" ")} ${READER_DEPTH_IDENTICAL} <span id="depth-late-context">${READER_DEPTH_LATE_CONTEXT}</span>.</p>
<p id="depth-vietnamese">${READER_DEPTH_VIETNAMESE}</p>` : ""}
${body}
</body>
</html>
`;
}

// A colophon: ONE short paragraph, which occupies a single column at every supported viewport, so
// there is nothing to page through inside it. That is the shape a purely fractional whole-book
// progression cannot describe - `scrollWidth === clientWidth` leaves Readium's column
// normalization no range and it reports `progression: 0` on the only page the resource has. Short
// final items are the ordinary shape of a real book, which is why this variant exists.
function shortChapter(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 3</title><link rel="stylesheet" href="../styles/style.css" type="text/css"/></head>
<body>
<h1>Chapter 3</h1>
<p>${CHAPTER_THREE_MARKER}.</p>
</body>
</html>
`;
}

// `title` defaults to the exact string the golden path's inline version used and both variant flags
// default to false, so a call with no options produces byte-identical output to the code this
// replaced. Verified by hashing this function's default output against the previous
// implementation's IN THE SAME PROCESS - `zipSync` stamps each entry with the current mtime, so the
// digest is only meaningful as a same-run comparison and a literal hash written down here would be
// a number that never reproduces.
//
//  - `shortFinalChapter` appends a one-paragraph third chapter, making the LAST reading-order item
//    single-column while the book still has several items.
//  - `onlyShortChapter` reduces the publication to that one short chapter alone, so the reader is
//    at the end of the book from the moment it opens. It wins if both are set.
export function buildFixtureEpub(
  options: { title?: string; shortFinalChapter?: boolean; onlyShortChapter?: boolean; chapterTwoParagraphs?: number; readerDepthFixture?: boolean } = {},
): Buffer {
  const title = options.title ?? "The Harbour Lights";
  const onlyShort = options.onlyShortChapter ?? false;
  const short = onlyShort || (options.shortFinalChapter ?? false);
  const chapterTwoParagraphs = options.chapterTwoParagraphs ?? 12;

  const spine = onlyShort ? ["chapter3"] : short ? ["chapter1", "chapter2", "chapter3"] : ["chapter1", "chapter2"];
  const chapterItem = (id: string) =>
    `    <item id="${id}" href="text/${id}.xhtml" media-type="application/xhtml+xml"/>`;
  const navEntry = (id: string) =>
    `<li><a href="text/${id}.xhtml">Chapter ${id.slice(-1)}</a></li>`;

  const entries: Zippable = {
    // OCF 3.3: `mimetype` must come first and be stored uncompressed.
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
      {},
    ],
    "OEBPS/content.opf": [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:5f1c0d9e-2c7a-4f52-9f0e-1b7d3c4a5e60</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Wren Ellory</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${spine.map(chapterItem).join("\n")}
    <item id="style" href="styles/style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
${spine.map((id) => `    <itemref idref="${id}"/>`).join("\n")}
  </spine>
</package>
`),
      {},
    ],
    "OEBPS/nav.xhtml": [
      strToU8(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
<nav epub:type="toc">
<ol>
${spine.map(navEntry).join("\n")}
</ol>
</nav>
</body>
</html>
`),
      {},
    ],
    // Chapter 1 is deliberately long enough to span several pages, and that is load-bearing, not
    // cosmetic. The restore proof's catch 2 turns a single page after reloading and checks which
    // resource the engine reports being in: if chapter 1 fitted on one page, that turn would cross
    // into chapter 2 even from a reader who had NOT been restored, and the assertion would pass
    // for the wrong reason. A self-check in the reading phase asserts this property against the
    // rendered book, so shrinking this count fails the spec loudly rather than quietly weakening
    // it. (Catch 1 is unaffected by any of this - see its own note.)
    ...(onlyShort
      ? {}
      : {
          "OEBPS/text/chapter1.xhtml": [strToU8(chapter("Chapter 1", CHAPTER_ONE_MARKER, 24, options.readerDepthFixture)), {}] as const,
          "OEBPS/text/chapter2.xhtml": [strToU8(chapter("Chapter 2", CHAPTER_TWO_MARKER, chapterTwoParagraphs)), {}] as const,
        }),
    ...(short ? { "OEBPS/text/chapter3.xhtml": [strToU8(shortChapter()), {}] as const } : {}),
    // The `h1` colour is load-bearing, not decoration: it is the signal the reader assertion in the
    // golden path reads back out of the rendered frame. An arbitrary, distinctive value nothing
    // else in the application would produce, so "the publication's own CSS is applied" cannot be
    // satisfied by ReadiumCSS, a browser default, or the app's own stylesheet.
    "OEBPS/styles/style.css": [
      strToU8("body { font-family: serif; line-height: 1.5; }\nh1 { color: rgb(1, 2, 3); }\n"),
      {},
    ],
    // Not a decodable JPEG: processing hashes and stores image bytes, never decodes them.
    "OEBPS/images/cover.jpg": [
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      {},
    ],
  };

  return Buffer.from(zipSync(entries));
}

// ================================================================================================
// A published book with a REAL processed publication
// ================================================================================================

function check<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as NonNullable<T>;
}

// The CLI below runs OUTSIDE this process and reads its own credentials. createServiceRoleClient()
// refuses a non-loopback Supabase URL, but nothing it does protects a child process, so the guard
// is repeated at the one place that spawns one. `npm run ebook` claims a job, rewrites storage and
// publishes rows; against the shared cloud project that is destructive.
function requireLoopbackForCli(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    throw new Error(
      `Refusing to run "npm run ebook" against "${url || "<unset>"}". The EPUB processing CLI ` +
        `claims jobs and writes publications; it may only ever run against a loopback stack.`,
    );
  }
}

// An admin who can call the publish RPCs. publish_publication and publish_book both resolve the
// caller through is_admin() -> auth.uid(), which is null under service_role, so they can only be
// called as a signed-in authenticated user (Ruling W/AE) - the same reason the golden path drives
// them through the admin UI.
async function signedInAdmin() {
  const service = createServiceRoleClient();
  const email = `seed-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "seed-admin-password-1";

  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  const profile = check(await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single());
  check(await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" }));

  const client = createAnonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return client;
}

// A published book with a REAL processed publication. Seeded catalog books (e2e/support/catalog.ts)
// cannot render: their manifest_key names an object that was never uploaded, so the reader gets a
// 502 and the sample manifest gets one too. Any test that needs the engine to actually paint needs
// this instead.
//
// This deliberately does NOT drive the admin UI. e2e/ebook-golden-path.spec.ts is the test of that
// path and keeps doing it through the browser; every other spec only needs the artefact.
export async function seedProcessedBook(options: {
  suffix: string;
  localizations: Partial<Record<"vi" | "en", { slug: string; title: string }>>;
  priceMinor?: number;
  // Fixture shape - see buildFixtureEpub for what each variant is for.
  shortFinalChapter?: boolean;
  onlyShortChapter?: boolean;
  readerDepthFixture?: boolean;
}): Promise<{ bookId: string; publicationId: string; slug: string; title: string }> {
  requireLoopbackForCli();

  const service = createServiceRoleClient();
  const { suffix, localizations } = options;
  const locale = (localizations.en ? "en" : "vi") as "vi" | "en";
  const { slug, title } = localizations[locale]!;

  // Step 1 - the catalog half. Everything publish_book's readiness check wants (localized copy, a
  // published author, a cover, an active offer) is exactly what seedCatalogBook already writes, so
  // this reuses it rather than repeating it. Its own placeholder publication is superseded in step
  // 5 by the real one, which is what publish_publication does to a previous active pointer anyway.
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations,
    priceMinor: options.priceMinor,
  });

  const edition = check(await service.from("editions").select("id").eq("book_id", bookId).single());

  // Step 2 - the source EPUB in the private bucket, and the ebook_assets row pointing at it. The
  // storage key has the same shape admin_reserve_ebook_asset derives, and the version follows the
  // placeholder asset's so complete_processing_job's stale-version check sees this as the newest.
  const bytes = buildFixtureEpub({
    title,
    shortFinalChapter: options.shortFinalChapter,
    onlyShortChapter: options.onlyShortChapter,
    readerDepthFixture: options.readerDepthFixture,
  });
  const assetId = randomUUID();
  const storageKey = `${edition.id}/${assetId}/source.epub`;
  check(
    await service.storage.from("ebook-source").upload(storageKey, bytes, {
      contentType: "application/epub+zip",
    }),
  );

  const versions = check(await service.from("ebook_assets").select("version").eq("edition_id", edition.id));
  const nextVersion = Math.max(0, ...versions.map((row: { version: number }) => row.version)) + 1;

  check(
    await service.from("ebook_assets").insert({
      id: assetId,
      edition_id: edition.id,
      source_storage_key: storageKey,
      source_checksum: createHash("sha256").update(bytes).digest("hex"),
      version: nextVersion,
      status: "queued",
    }),
  );

  // Step 3 - the queued job the worker claims. admin_finalize_ebook_asset writes this in the real
  // flow; it is admin-gated and there is no admin session yet at this point, so the row is seeded.
  check(
    await service
      .from("processing_jobs")
      .insert({ target_id: assetId, status: "queued", correlation_id: `e2e-seed-${suffix}` }),
  );

  // Step 4 - the real CLI, the actual command an operator runs (docs/runbooks/epub-processing.md).
  // Failures here print the correlation id and a stable ProcessingFailureCode on stderr; surfacing
  // that is what tells a seeding failure apart from a reader defect.
  try {
    execFileSync("npm", ["run", "ebook", "--", "process", "--asset", assetId], {
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
  } catch (error) {
    const child = error as { stdout?: string; stderr?: string };
    throw new Error(
      `seedProcessedBook: the EPUB processing CLI failed for asset ${assetId}\n` +
        `stdout: ${child.stdout ?? ""}\nstderr: ${child.stderr ?? ""}`,
    );
  }

  const publication = check(
    await service.from("ebook_publications").select("id").eq("ebook_asset_id", assetId).single(),
  );
  const publicationId = publication.id as string;

  // The sample allowlist. The CLI processes with the default policy, whose sampleHrefs set is empty
  // (lib/epub/process.ts) - there is no operator-facing way to declare a sample yet - so the two
  // rows the processor WOULD have written for "give away chapter one" are written here instead:
  // the allowlist, and access_class = 'sample' on the same hrefs. Both are required, and
  // resolveSampleResource refuses an href unless they agree, so setting one alone would produce a
  // book the catalog claims has a sample and whose sample reader is empty.
  //
  // The stylesheet is included for the reason Ruling AW's transitive closure includes it: a sample
  // chapter that cannot load its own CSS is not a sample of the book. Chapter 2 and the cover stay
  // 'paid', which is what gives the sample specs a real negative case.
  const sampleHrefs = [options.onlyShortChapter ? CHAPTER_THREE_HREF : CHAPTER_ONE_HREF, STYLESHEET_HREF];
  check(
    await service
      .from("ebook_resources")
      .update({ access_class: "sample" })
      .eq("publication_id", publicationId)
      .in("href", sampleHrefs),
  );
  check(
    await service.from("book_samples").update({ allowed_hrefs: sampleHrefs }).eq("publication_id", publicationId),
  );

  // Step 5 - publish, through the same RPCs the admin UI calls. publish_publication moves the
  // active pointer (superseding the placeholder publication); publish_book is what makes the book
  // and its author public.
  const admin = await signedInAdmin();
  const { error: publishPublicationError } = await admin.rpc("publish_publication", {
    p_publication_id: publicationId,
  });
  if (publishPublicationError) throw publishPublicationError;

  const { error: publishBookError } = await admin.rpc("publish_book", { p_book_id: bookId });
  if (publishBookError) throw publishBookError;

  // Step 6 - read back, and fail here rather than in a spec. An empty allowlist at this point means
  // the seeding is broken; without this check it surfaces much later as a sample page that 404s or
  // a sample reader that paints nothing, which reads as a defect in the code under test.
  const stored = check(
    await service.from("book_samples").select("allowed_hrefs").eq("publication_id", publicationId).single(),
  );
  const allowed = (stored.allowed_hrefs ?? []) as string[];
  if (allowed.length === 0) {
    throw new Error(`seedProcessedBook: publication ${publicationId} was seeded with an empty sample allowlist`);
  }

  return { bookId, publicationId, slug, title };
}

// The complimentary grant, through the real RPC as a signed-in admin. grant_complimentary_
// entitlement writes the entitlement, the library_items row the library page reads, and an
// immutable audit row in one transaction, and its is_admin() check resolves through auth.uid() -
// null under service_role - so it cannot be called any other way.
export async function grantEntitlement(bookId: string, email: string): Promise<void> {
  const service = createServiceRoleClient();
  const profile = check(
    await service
      .from("customer_identities")
      .select("profile_id")
      .eq("normalized_email", email.toLowerCase())
      .single(),
  );

  const admin = await signedInAdmin();
  const { error } = await admin.rpc("grant_complimentary_entitlement", {
    p_profile_id: profile.profile_id,
    p_book_id: bookId,
    p_reason: "E2E reader journey",
  });
  if (error) throw error;
}
