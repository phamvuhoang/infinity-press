import type { ReaderLocator } from "@/lib/reader/types";

// Output contract of `processEpub()` (Task 4), consumed as-is by the local
// worker's `JobStore.putDerived`/`complete` (Task 5) and by manifest/session
// delivery (Task 8). Framework- and database-neutral per spec 4.3: no
// Next.js or Supabase types may appear here, and nothing here may name a
// specific reader engine.

export type PublicationMetadata = {
  title: string;
  language: string;
  identifier: string;
  authors: string[];
};

// One entry in the book's spine: the ordered sequence of content documents
// a reader steps through with next()/previous(). Mirrors the Readium Web
// Publication Manifest `readingOrder` link shape so Task 8 can project it
// into a manifest response without renaming fields.
export type ReadingOrderItem = {
  href: string;
  mediaType: string;
};

export type TocEntry = {
  title: string;
  href: string;
  children: TocEntry[];
};

// Matches `ebook_resources.access_class`: every resource is either part of
// the paid book or explicitly cleared for anonymous sample delivery. There
// is no third state and no way to derive "sample" from anything other than
// this field plus the publication's explicit `sampleHrefs` allowlist -
// never from a client-supplied parameter.
export type ResourceAccessClass = "paid" | "sample";

export type ProcessedResource = {
  href: string;
  mediaType: string;
  byteSize: number;
  // SHA-256 of `bytes`, hex-encoded. Mirrors `ebook_resources.sha256`, and
  // lets the worker (Task 5) detect a corrupted or already-uploaded object
  // without re-reading it from storage.
  sha256: string;
  accessClass: ResourceAccessClass;
  // The exact derived bytes to write to storage. Present for every
  // resource, including binary assets (images, fonts) that have no `text`.
  bytes: Uint8Array;
  // Sanitized UTF-8 content for text-based resources (XHTML, CSS, NCX).
  // Undefined for binary resources. Lets sanitization tests (Task 4) assert
  // on decoded content instead of re-decoding `bytes` themselves.
  text?: string;
};

// Search and position extraction are processor output, intentionally expressed with
// the engine-neutral ReaderLocator rather than a database or reader-runtime type.
// Task 3 persists these values after `processEpub()` has produced the sanitized
// resources they are derived from. Extracted locators carry `locations.cssSelector`
// and a zero-based Unicode-code-point `locations.textOffset` into that selector's
// whitespace-normalized visible text; the offset is only valid when quote/context
// verification also succeeds.
export type ProcessedSearchChunk = {
  href: string;
  chapterTitle: string | null;
  ordinal: number;
  plainText: string;
  locator: ReaderLocator;
};

export type ProcessedSearchIndex = {
  searchChunks: ProcessedSearchChunk[];
  positions: ReaderLocator[];
};

// Mirrors the publishing-schema columns this processor output is written
// into: `ebook_publications` (metadata, toc_json), `ebook_resources` (one
// row per entry in `resources`), and `book_samples.allowed_hrefs`
// (`sampleHrefs`). The processor never imports those generated database
// types directly - this type is the seam between the two.
export type ProcessedPublication = {
  metadata: PublicationMetadata;
  readingOrder: ReadingOrderItem[];
  resources: ProcessedResource[];
  toc: TocEntry[];
  // Explicit allowlist of hrefs servable without an entitlement. Duplicated
  // out of `resources[].accessClass` (rather than requiring every consumer
  // to filter for it) because Task 8's sample route must check against a
  // named allowlist, not an inferred one.
  sampleHrefs: string[];
  // Search and position output is mandatory for every newly processed publication. Keeping it
  // in this immutable processor contract prevents a ready publication from becoming visible
  // before the private reader index that describes its sanitized XHTML is persisted.
  searchChunks: ProcessedSearchChunk[];
  positions: ReaderLocator[];
};

// Input contract of `processEpub()`'s second argument (Task 4). Task 1 deliberately did
// not define this - limits and allowlists are processing-specific decisions, not part of
// the output seam above - so it lives here instead of in the module that happens to
// consume the smallest slice of it (`lib/epub/sanitize.ts` only ever needs
// `allowedDataUrlMediaTypes`; `allowedMediaTypes` and `sampleHrefs` are `process.ts`'s).
export type ProcessingPolicy = {
  // Media types every manifest resource must be declared as, or the publication is
  // rejected wholesale with UNSUPPORTED_MEDIA - not silently dropped.
  allowedMediaTypes: ReadonlySet<string>;
  // `data:` URLs are otherwise treated the same as any other externally-schemed
  // reference (rejected); this narrows that to a specific allowlist of inline media
  // types content is permitted to embed directly.
  allowedDataUrlMediaTypes: ReadonlySet<string>;
  // Caller-declared candidate hrefs (e.g. "give away the first chapter"). Advisory only:
  // an href here that does not match any actual resource is silently ignored rather than
  // failing processing, and the *output* `sampleHrefs` above is always derived from
  // `resources[].accessClass` - including its Ruling AW closure over referenced assets -
  // never by echoing this set back out.
  sampleHrefs: ReadonlySet<string>;
};
