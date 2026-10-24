// Semantic EPUB parsing: turns a validated `SafeArchive` (Task 4's `archive.ts`) into the
// structural facts `process.ts` needs - metadata, manifest, reading order, and table of
// contents. Every XML document here (`container.xml`, the OPF package document, the EPUB3
// navigation document, the EPUB2 NCX) is parsed with entities disabled: `processEntities:
// false` is the XXE and billion-laughs defence (Ruling AF's parsing counterpart) and is
// not optional, proved by a fixture in `parse.test.ts` rather than only configured here.
import { strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

import {
  dirnameOf,
  externalUrlScheme,
  resolveInPublicationReference,
  splitFragment,
  type SafeArchive,
} from "@/lib/epub/archive";
import { ProcessingError, processingFailure } from "@/lib/epub/errors";
import type { PublicationMetadata, ReadingOrderItem, TocEntry } from "@/lib/epub/types";

function invalidEpub(message: string): never {
  throw new ProcessingError(processingFailure("INVALID_EPUB", message));
}

// Tags that must always parse to an array regardless of how many times they occur, so
// "exactly one root package document" and "zero-length spine" can be checked by reading
// `.length` rather than branching on whether fast-xml-parser produced an object or an
// array for this particular document.
const ARRAY_TAGS = new Set(["rootfile", "item", "itemref", "creator", "identifier", "li", "navPoint", "nav"]);

// Shared across every XML document this module parses. `removeNSPrefix: true` means a
// namespaced element like `<dc:title>` or an attribute like `epub:type` is read back as
// `title` / `type` - this module only ever reads Dublin Core metadata and OPF/NCX
// structure by local name, so collapsing prefixes removes a class of "did the document use
// `dc:` or `opf:` or no prefix at all" bugs without losing any information we use.
//
// A single module-level instance, matching `sanitize.ts`'s `xmlWellFormednessParser`:
// `XMLParser` itself holds nothing but its (immutable) options - `.parse()` constructs a
// fresh internal parser for every call (`fast-xml-parser`'s `XMLParser.parse()` does `new
// OrderedObjParser(this.options, ...)` per invocation), so there is no per-document state
// that could leak between calls, and no reason to pay construction cost per document.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: false,
  allowBooleanAttributes: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

function parseXml(bytes: Uint8Array, describeFor: string): Record<string, unknown> {
  const text = strFromU8(bytes);
  try {
    return xmlParser.parse(text, true) as Record<string, unknown>;
  } catch (error) {
    invalidEpub(`${describeFor} is not well-formed XML: ${(error as Error).message}`);
  }
}

function readEntry(archive: SafeArchive, path: string, describeFor: string): Uint8Array {
  const bytes = archive.entries.get(path);
  if (!bytes) {
    invalidEpub(`${describeFor} references a missing archive entry: ${path}`);
  }
  return bytes;
}

// fast-xml-parser renders element text as a plain string when the element has no
// attributes/children, but as `{ "#text": "...", "@_...": ... }` when it also carries
// attributes (e.g. `<dc:identifier id="pub-id">...`). Both shapes need to read the same.
// A repeated element (OPF allows several `<dc:title>`/`<dc:language>`) parses as an
// array; the first one is the primary value.
function textOf(value: unknown): string {
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export type ParsedManifestItem = {
  id: string;
  href: string; // normalized in-archive path
  mediaType: string;
  properties: string[];
};

export type ParsedEpub = {
  metadata: PublicationMetadata;
  manifest: ParsedManifestItem[];
  readingOrder: ReadingOrderItem[];
  opfDir: string;
  navHref?: string;
  ncxHref?: string;
};

// container.xml (OCF section 3.5.1): must name exactly one root package document. EPUB
// permits multiple `<rootfile>` entries for alternate renditions, but this MVP processor
// only supports a single-rendition publication.
function resolveRootfilePath(archive: SafeArchive): string {
  const containerXml = readEntry(archive, "META-INF/container.xml", "META-INF/container.xml");
  const parsed = parseXml(containerXml, "META-INF/container.xml");

  const container = parsed.container as Record<string, unknown> | undefined;
  const rootfiles = container?.rootfiles as Record<string, unknown> | undefined;
  const rootfileEntries = asArray(rootfiles?.rootfile as Record<string, unknown> | Record<string, unknown>[] | undefined);

  if (rootfileEntries.length !== 1) {
    invalidEpub(
      `META-INF/container.xml must reference exactly one root package document, found ${rootfileEntries.length}`,
    );
  }

  const fullPath = rootfileEntries[0]["@_full-path"];
  if (typeof fullPath !== "string" || fullPath.length === 0) {
    invalidEpub("META-INF/container.xml rootfile is missing a full-path attribute");
  }

  if (externalUrlScheme(fullPath) !== null) {
    invalidEpub(`META-INF/container.xml rootfile full-path must be a relative reference: ${fullPath}`);
  }
  const resolved = resolveInPublicationReference("", fullPath);
  if (resolved === null || !archive.entries.has(resolved)) {
    invalidEpub(`META-INF/container.xml points to a missing package document: ${fullPath}`);
  }
  return resolved;
}

function parseMetadata(metadataNode: Record<string, unknown> | undefined, packageUniqueId: string | undefined): PublicationMetadata {
  if (!metadataNode) {
    invalidEpub("Package document is missing a <metadata> element");
  }

  const titleValue = textOf(metadataNode.title).trim();
  const languageValue = textOf(metadataNode.language).trim();

  const identifierEntries = asArray(metadataNode.identifier as Record<string, unknown> | Record<string, unknown>[] | string | undefined);
  const preferredIdentifier =
    identifierEntries.find((entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["@_id"] === packageUniqueId) ??
    identifierEntries[0];
  const identifierValue = textOf(preferredIdentifier).trim();

  if (titleValue.length === 0 || languageValue.length === 0 || identifierValue.length === 0) {
    invalidEpub("Package document metadata is missing a required title, language, or identifier");
  }

  const authors = asArray(metadataNode.creator as Record<string, unknown> | Record<string, unknown>[] | string | undefined)
    .map((entry) => textOf(entry).trim())
    .filter((value) => value.length > 0);

  return { title: titleValue, language: languageValue, identifier: identifierValue, authors };
}

// Parses the OPF package document into manifest items, reading order, and metadata. A
// "readable spine" means every `<itemref idref="...">` resolves to a manifest item and the
// spine is non-empty - both are required here, not left to fail later during resource
// resolution.
export function parseEpub(archive: SafeArchive): ParsedEpub {
  const opfPath = resolveRootfilePath(archive);
  const opfDir = dirnameOf(opfPath);
  const opfBytes = readEntry(archive, opfPath, "Package document");
  const parsed = parseXml(opfBytes, "Package document");

  const packageNode = parsed.package as Record<string, unknown> | undefined;
  if (!packageNode) {
    invalidEpub("Package document is missing a root <package> element");
  }

  const metadata = parseMetadata(packageNode.metadata as Record<string, unknown> | undefined, packageNode["@_unique-identifier"] as string | undefined);

  const manifestNode = packageNode.manifest as Record<string, unknown> | undefined;
  const manifestItemEntries = asArray(manifestNode?.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (manifestItemEntries.length === 0) {
    invalidEpub("Package document manifest has no items");
  }

  const manifestById = new Map<string, ParsedManifestItem>();
  for (const entry of manifestItemEntries) {
    const id = entry["@_id"];
    const href = entry["@_href"];
    const mediaType = entry["@_media-type"];
    if (typeof id !== "string" || typeof href !== "string" || typeof mediaType !== "string") {
      invalidEpub("Package document manifest item is missing id, href, or media-type");
    }
    if (externalUrlScheme(href) !== null) {
      invalidEpub(`Package document manifest item "${id}" has a non-relative href: ${href}`);
    }
    const resolvedHref = resolveInPublicationReference(opfDir, href);
    if (resolvedHref === null || !archive.entries.has(resolvedHref)) {
      invalidEpub(`Package document manifest item "${id}" references a missing resource: ${href}`);
    }
    const properties = typeof entry["@_properties"] === "string" ? (entry["@_properties"] as string).split(/\s+/).filter(Boolean) : [];
    if (manifestById.has(id)) {
      invalidEpub(`Package document manifest declares duplicate id: ${id}`);
    }
    manifestById.set(id, { id, href: resolvedHref, mediaType, properties });
  }

  const spineNode = packageNode.spine as Record<string, unknown> | undefined;
  const itemrefEntries = asArray(spineNode?.itemref as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (itemrefEntries.length === 0) {
    invalidEpub("Package document spine has no itemref entries");
  }

  const readingOrder: ReadingOrderItem[] = itemrefEntries.map((entry) => {
    const idref = entry["@_idref"];
    if (typeof idref !== "string") {
      invalidEpub("Package document spine itemref is missing idref");
    }
    const item = manifestById.get(idref);
    if (!item) {
      invalidEpub(`Package document spine references an unknown manifest item: ${idref}`);
    }
    return { href: item.href, mediaType: item.mediaType };
  });

  const manifest = [...manifestById.values()];
  const navItem = manifest.find((item) => item.properties.includes("nav"));

  const ncxId = typeof spineNode?.["@_toc"] === "string" ? (spineNode["@_toc"] as string) : undefined;
  const ncxItem = ncxId ? manifestById.get(ncxId) : undefined;

  return {
    metadata,
    manifest,
    readingOrder,
    opfDir,
    navHref: navItem?.href,
    ncxHref: ncxItem?.href,
  };
}

// --- Table of contents -----------------------------------------------------------------
//
// Named supported-profile decision (spec 8): TOC extraction is best-effort, not
// load-bearing. Neither an EPUB3 nav document nor an EPUB2 NCX is required the way the
// manifest and spine are - the brief's hard requirements are `mimetype`, container XML,
// one root package document, and a readable spine, and a book with a broken or absent
// navigation document is still a readable book. A nav/ncx that is present but malformed
// degrades to an empty `toc: []` rather than failing the whole publication.
//
// Consequence for later consumers: an empty `toc` this way is indistinguishable from a
// publication that genuinely has no table of contents at all - a consumer (e.g. an admin
// preview) must not treat `toc.length === 0` as proof of "this book has no TOC" without
// accounting for that ambiguity.

function findTocNav(navDoc: Record<string, unknown>): Record<string, unknown> | undefined {
  const html = navDoc.html as Record<string, unknown> | undefined;
  const body = html?.body as Record<string, unknown> | undefined;
  const navs = asArray(body?.nav as Record<string, unknown> | Record<string, unknown>[] | undefined);
  return navs.find((nav) => nav["@_type"] === "toc") ?? navs[0];
}

// TOC hrefs are declared relative to the nav/NCX document that names them, which is not
// necessarily the OPF's own directory - resolved the same way any other in-document
// reference is (see `sanitize.ts`), and silently dropped (not resolved-but-wrong) if they
// turn out to be external or archive-escaping.
//
// EPUB3 nav `a href` and NCX `content src` routinely carry a fragment
// (`chapter1.xhtml#sec1`, pointing at a location *within* the target document, not a
// different resource) - resolving the whole string including the fragment would produce
// a path matching no `ProcessedResource.href`, silently breaking the TOC entry for every
// reader that tries to follow it. Resolve the path portion alone (so it matches a real
// resource) and re-attach the original fragment to the *display* href this function
// returns - `resolveInPublicationReference` already discards the fragment internally, so
// only the re-attachment needs doing here.
function parseNavList(listNode: Record<string, unknown> | undefined, baseDir: string): TocEntry[] {
  if (!listNode) return [];
  const items = asArray(listNode.li as Record<string, unknown> | Record<string, unknown>[] | undefined);
  return items
    .map((item): TocEntry | null => {
      const anchor = item.a as Record<string, unknown> | undefined;
      const rawHref = anchor?.["@_href"];
      if (typeof rawHref !== "string" || externalUrlScheme(rawHref) !== null) return null;
      const resolvedPath = resolveInPublicationReference(baseDir, rawHref);
      if (resolvedPath === null) return null;
      const href = resolvedPath + splitFragment(rawHref).fragment;
      const title = textOf(anchor).trim();
      const children = parseNavList(item.ol as Record<string, unknown> | undefined, baseDir);
      return { title, href, children };
    })
    .filter((entry): entry is TocEntry => entry !== null);
}

function parseNavToc(archive: SafeArchive, navHref: string): TocEntry[] {
  const bytes = readEntry(archive, navHref, "EPUB3 navigation document");
  const parsed = parseXml(bytes, "EPUB3 navigation document");
  const navDoc = parsed as Record<string, unknown>;
  const tocNav = findTocNav(navDoc);
  if (!tocNav) return [];
  return parseNavList(tocNav.ol as Record<string, unknown> | undefined, dirnameOf(navHref));
}

function parseNavPoints(navPoints: Record<string, unknown>[], baseDir: string): TocEntry[] {
  return navPoints
    .map((navPoint): TocEntry | null => {
      const navLabel = navPoint.navLabel as Record<string, unknown> | undefined;
      const title = textOf(navLabel?.text).trim();
      const content = navPoint.content as Record<string, unknown> | undefined;
      const rawHref = content?.["@_src"];
      if (typeof rawHref !== "string" || externalUrlScheme(rawHref) !== null) return null;
      const resolvedPath = resolveInPublicationReference(baseDir, rawHref);
      if (resolvedPath === null) return null;
      const href = resolvedPath + splitFragment(rawHref).fragment;
      const children = parseNavPoints(asArray(navPoint.navPoint as Record<string, unknown> | Record<string, unknown>[] | undefined), baseDir);
      return { title, href, children };
    })
    .filter((entry): entry is TocEntry => entry !== null);
}

function parseNcxToc(archive: SafeArchive, ncxHref: string): TocEntry[] {
  const bytes = readEntry(archive, ncxHref, "NCX document");
  const parsed = parseXml(bytes, "NCX document");
  const ncx = parsed.ncx as Record<string, unknown> | undefined;
  const navMap = ncx?.navMap as Record<string, unknown> | undefined;
  return parseNavPoints(asArray(navMap?.navPoint as Record<string, unknown> | Record<string, unknown>[] | undefined), dirnameOf(ncxHref));
}

export function buildToc(archive: SafeArchive, parsed: ParsedEpub): TocEntry[] {
  try {
    if (parsed.navHref) {
      const toc = parseNavToc(archive, parsed.navHref);
      if (toc.length > 0) return toc;
    }
    if (parsed.ncxHref) {
      return parseNcxToc(archive, parsed.ncxHref);
    }
  } catch {
    return [];
  }
  return [];
}
