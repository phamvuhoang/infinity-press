// Archive-level safety for untrusted EPUB (ZIP) input. Everything here runs before any
// document inside the archive is interpreted as XML/XHTML - path traversal, entry-count,
// and decompression-ratio checks all belong here so `parse.ts`/`sanitize.ts` only ever see
// bytes that already passed the zip-bomb and zip-slip gates (spec 8, Ruling AF).
import { strFromU8, unzipSync } from "fflate";

import { EPUB_MIME_TYPE } from "@/lib/epub/constants";
import { ProcessingError, processingFailure } from "@/lib/epub/errors";

export const MAX_ARCHIVE_ENTRIES = 2000;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_ENTRY_COMPRESSION_RATIO = 100;

export const CONTAINER_XML_PATH = "META-INF/container.xml";
const MIMETYPE_ENTRY_NAME = "mimetype";
const STORED_COMPRESSION_METHOD = 0;

export type SafeArchive = {
  // Normalized in-archive path -> decompressed bytes. Directory entries are omitted, and
  // every key has already passed `normalizeArchiveEntryPath` (no absolute paths, no `..`
  // segments, no duplicates).
  entries: ReadonlyMap<string, Uint8Array>;
};

function invalidEpub(message: string): never {
  throw new ProcessingError(processingFailure("INVALID_EPUB", message));
}

function tooLarge(message: string): never {
  throw new ProcessingError(processingFailure("ASSET_TOO_LARGE", message));
}

// Splits and validates one *archive entry* path (a raw ZIP member name), rejecting
// anything that could name a location outside the archive's own flat namespace. EPUB/ZIP
// entry names never legitimately need `..`, unlike in-document references (see
// `resolveInPublicationReference` below), so any `..` segment - raw or percent-encoded -
// is a hard rejection here, not something to resolve.
export function normalizeArchiveEntryPath(rawName: string): string {
  if (rawName.length === 0) {
    invalidEpub("Archive entry has an empty name");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    invalidEpub(`Archive entry name is not validly encoded: ${rawName}`);
  }

  const normalizedSlashes = decoded.replace(/\\/g, "/");
  if (normalizedSlashes.startsWith("/") || /^[a-zA-Z]:/.test(normalizedSlashes)) {
    invalidEpub(`Archive entry path is absolute: ${rawName}`);
  }

  const cleaned: string[] = [];
  for (const segment of normalizedSlashes.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      invalidEpub(`Archive entry path escapes the archive root: ${rawName}`);
    }
    cleaned.push(segment);
  }

  if (cleaned.length === 0) {
    invalidEpub(`Archive entry path is empty after normalization: ${rawName}`);
  }

  return cleaned.join("/");
}

// Returns the directory portion of a normalized in-archive path ("" for a top-level path).
export function dirnameOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf("/");
  return slash === -1 ? "" : normalizedPath.slice(0, slash);
}

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const UNSAFE_REFERENCE_CHAR_PATTERN = /[\x00-\x20]/;

// True if `ref` contains a control character or space anywhere in its body. A browser's
// own URL parser silently strips exactly these characters (WHATWG URL tab/newline/CR
// stripping) before it ever looks for a scheme, so `java<TAB>script:alert(1)` reads, to a
// naive scheme regex applied to the raw string, as a harmless relative path - while a
// browser reassembles it back into the executable scheme it always was. Reject before
// attempting to classify a scheme at all, rather than have this module's own validator
// reach the opposite conclusion from the one a browser will act on.
export function hasUnsafeReferenceCharacters(ref: string): boolean {
  return UNSAFE_REFERENCE_CHAR_PATTERN.test(ref);
}

// Returns the lowercase URI scheme of `ref` (e.g. "https", "javascript", "data"), the
// sentinel `"//"` for a protocol-relative reference, or `null` if `ref` has no scheme at
// all (a same-publication relative reference). Centralized so "what counts as external"
// is one rule shared by every caller that validates a reference - `parse.ts`'s manifest
// hrefs and `sanitize.ts`'s content hrefs/srcs alike - rather than each inventing its own
// scheme regex and risking the two disagreeing.
export function externalUrlScheme(ref: string): string | null {
  if (ref.startsWith("//")) return "//";
  const match = SCHEME_PATTERN.exec(ref);
  return match ? match[1].toLowerCase() : null;
}

// Splits a reference into its path and fragment (`#...`, including the leading `#`, or
// `""` if there is none). Fragment identifiers (`chapter2.xhtml#sec1`, as NCX `content
// src` and EPUB3 nav `a href` both commonly carry) name a location *within* a resource,
// not a different resource - resolving/looking up a resource must use the path alone, or
// `chapter2.xhtml#sec1` matches no `ProcessedResource.href` and silently fails. The
// fragment survives separately only so a caller that builds a *display* href (a TOC
// entry) can re-attach it to the resolved path.
export function splitFragment(ref: string): { path: string; fragment: string } {
  const hashIndex = ref.indexOf("#");
  if (hashIndex === -1) return { path: ref, fragment: "" };
  return { path: ref.slice(0, hashIndex), fragment: ref.slice(hashIndex) };
}

// Resolves an in-document reference (an OPF manifest `href`, or an `href`/`src` found
// inside sanitized content) against the directory of the document that names it. Unlike
// `normalizeArchiveEntryPath`, `..` here is resolved (popped against `baseDir`) rather
// than rejected outright, because EPUB content legitimately organizes text and images into
// sibling directories (`../images/cover.jpg` from `text/chapter1.xhtml`). Returns `null`
// for anything that is not a same-publication relative reference: an absolute path, a
// reference that escapes the archive root, a value containing a character
// `hasUnsafeReferenceCharacters` rejects, or (the caller checks this first in practice) a
// scheme-qualified/protocol-relative URL. Any fragment is discarded before resolution (see
// `splitFragment`) - the return value is always a path with no `#`. Percent-decoding
// happens before segment checks so `a/../b` and `a/%2e%2e/b` are judged by the same rule.
export function resolveInPublicationReference(baseDir: string, ref: string): string | null {
  if (hasUnsafeReferenceCharacters(ref)) return null;

  // Defense in depth: callers are expected to classify a scheme-qualified or
  // protocol-relative reference themselves (they usually need to react differently, e.g.
  // sanitize.ts's `data:` allowlist), but treating one as "does not resolve" here too
  // means this function is never the reason such a reference is mistaken for a relative
  // in-publication path.
  if (externalUrlScheme(ref) !== null) return null;

  const { path: refPath } = splitFragment(ref);

  let decoded: string;
  try {
    decoded = decodeURIComponent(refPath);
  } catch {
    return null;
  }

  const normalizedSlashes = decoded.replace(/\\/g, "/");
  if (normalizedSlashes.startsWith("/") || /^[a-zA-Z]:/.test(normalizedSlashes)) {
    return null;
  }

  const stack = baseDir.length > 0 ? baseDir.split("/") : [];
  for (const segment of normalizedSlashes.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null; // escapes the archive root
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  if (stack.length === 0) return null;
  return stack.join("/");
}

// Opens and validates an EPUB archive. Ruling AF: the central-directory metadata fflate's
// `filter` callback receives (declared entry count, declared uncompressed size, declared
// compressed size) is read and enforced for every entry *before* that entry is
// decompressed - `unzipSync` calls `filter(entryInfo)` for a central-directory record and
// only inflates the entry if the callback returns `true`, so throwing from inside `filter`
// aborts before the entry that would break the budget is ever inflated. Every entry
// processed up to that point was already individually and cumulatively within budget, so
// no code path here inflates more than the validated-safe declared total.
export function openEpubArchive(bytes: Uint8Array): SafeArchive {
  let entryCount = 0;
  let cumulativeDeclaredBytes = 0;
  let sawFirstEntry = false;
  const seenPaths = new Set<string>();

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter(file) {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
          tooLarge(`Archive has more than ${MAX_ARCHIVE_ENTRIES} entries`);
        }

        const isFirstEntry = !sawFirstEntry;
        sawFirstEntry = true;
        if (isFirstEntry) {
          // OCF 3.x section 3.3: the `mimetype` file must be the first entry in the
          // archive and stored without compression, so this must be checked here -
          // before anything is decompressed, not after we already have a result to
          // inspect.
          if (file.name !== MIMETYPE_ENTRY_NAME) {
            invalidEpub(`The first archive entry must be named "${MIMETYPE_ENTRY_NAME}"`);
          }
          if (file.compression !== STORED_COMPRESSION_METHOD) {
            invalidEpub(`The "${MIMETYPE_ENTRY_NAME}" entry must be stored without compression`);
          }
        }

        const isDirectory = file.name.endsWith("/");
        if (!isDirectory) {
          const normalized = normalizeArchiveEntryPath(file.name);
          if (seenPaths.has(normalized)) {
            invalidEpub(`Duplicate archive entry path: ${normalized}`);
          }
          seenPaths.add(normalized);
        }

        cumulativeDeclaredBytes += file.originalSize;
        if (cumulativeDeclaredBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          tooLarge(`Archive's declared uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`);
        }

        const ratio = file.originalSize / Math.max(1, file.size);
        if (ratio > MAX_ENTRY_COMPRESSION_RATIO) {
          tooLarge(`Archive entry "${file.name}" exceeds a ${MAX_ENTRY_COMPRESSION_RATIO}:1 compression ratio`);
        }

        return !isDirectory;
      },
    });
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    invalidEpub(`Archive could not be read as a valid ZIP file: ${(error as Error).message}`);
  }

  if (entryCount === 0) {
    invalidEpub("Archive contains no entries");
  }

  const entries = new Map<string, Uint8Array>();
  for (const [rawName, data] of Object.entries(raw)) {
    entries.set(normalizeArchiveEntryPath(rawName), data);
  }

  const mimetypeBytes = entries.get(MIMETYPE_ENTRY_NAME);
  if (!mimetypeBytes) {
    invalidEpub(`Archive is missing the "${MIMETYPE_ENTRY_NAME}" entry`);
  }
  if (strFromU8(mimetypeBytes) !== EPUB_MIME_TYPE) {
    invalidEpub(`The "${MIMETYPE_ENTRY_NAME}" entry must contain exactly "${EPUB_MIME_TYPE}"`);
  }

  if (!entries.has(CONTAINER_XML_PATH)) {
    invalidEpub(`Archive is missing ${CONTAINER_XML_PATH}`);
  }

  return { entries };
}
