// Orchestrates the deterministic EPUB processing pipeline: unzip safely (`archive.ts`),
// parse structure (`parse.ts`), sanitize content (`sanitize.ts`), and assemble the
// `ProcessedPublication` contract Task 1 defined. Pure function, no database or storage
// dependency (spec 4.3) - Task 5 wraps this with IO.
import { createHash } from "node:crypto";

import { openEpubArchive, type SafeArchive } from "@/lib/epub/archive";
import { ProcessingError, processingFailure } from "@/lib/epub/errors";
import { buildToc, parseEpub, type ParsedManifestItem } from "@/lib/epub/parse";
import { scanCss, sanitizeXhtml } from "@/lib/epub/sanitize";
import type { ProcessedPublication, ProcessedResource, ProcessingPolicy } from "@/lib/epub/types";
import { buildSearchIndex } from "@/lib/epub/search-index";

export type { ProcessingPolicy } from "@/lib/epub/types";

const XHTML_MEDIA_TYPE = "application/xhtml+xml";
const CSS_MEDIA_TYPE = "text/css";

// Launch supports horizontal layout only. Vertical writing is detected in the publication's own
// stylesheets (the standard property and the EPUB-prefixed legacy one) and refused up front, with a
// message an operator can act on, rather than published into a reader that was never tested for it.
// The scan runs on the sheet with its comments removed and its CSS escapes decoded, so neither
// `/* */` around the declaration nor `writing\-mode` hides it; sideways-* is vertical too.
const VERTICAL_WRITING_PATTERN = /(?:^|[;{\s])(?:-epub-|-webkit-)?writing-mode\s*:\s*(?:vertical-|sideways-|tb-)/i;

function setsVerticalWriting(css: string): boolean {
  const plain = css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(.)/g, "$1");
  return VERTICAL_WRITING_PATTERN.test(plain);
}

// Named supported-profile exclusion (spec 8, alongside sanitize.ts's `<style>`
// exclusion): `image/svg+xml` is not in the default allowlist. SVG is XML and can carry
// its own `<script>` - inert when the resource is only ever reached via `<img src>`
// (browsers do not execute scripts in an image-context SVG), but live the moment it is
// requested directly, which is exactly how Task 8 serves resources (by href). Sanitizing
// SVG would need the same XHTML-grade tag/attribute allowlist this module already
// maintains, duplicated for a different root element and namespace, for a media type EPUB
// content does not require - raster formats (`image/jpeg`, `image/png`, ...) cover the
// same use cases without the risk. A caller that has scanned or sanitized its own SVGs by
// some other means may still opt back in by passing a policy with a wider
// `allowedMediaTypes`.
export const DEFAULT_ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  XHTML_MEDIA_TYPE,
  CSS_MEDIA_TYPE,
  "application/x-dtbncx+xml",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "font/otf",
  "font/ttf",
  "font/woff",
  "font/woff2",
  "application/vnd.ms-opentype",
  "application/font-woff",
  "application/x-font-ttf",
]);

export const DEFAULT_ALLOWED_DATA_URL_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif"]);

export const DEFAULT_PROCESSING_POLICY: ProcessingPolicy = {
  allowedMediaTypes: DEFAULT_ALLOWED_MEDIA_TYPES,
  allowedDataUrlMediaTypes: DEFAULT_ALLOWED_DATA_URL_MEDIA_TYPES,
  sampleHrefs: new Set(),
};

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// On-demand text decoding for any resource, independent of whether `ProcessedResource.text`
// happens to be populated for it. `process.ts` only populates `.text` for XHTML resources
// (see the module-level note in `buildResource` below) - callers that want CSS/NCX text
// without `process.ts` having to keep a second UTF-8 copy of every text-bearing resource
// alongside `.bytes` can decode it from `.bytes` here instead.
export function decodeText(resource: ProcessedResource): string {
  return textDecoder.decode(resource.bytes);
}

type BuiltResource = {
  resource: ProcessedResource;
  // Normalized in-archive paths this resource's own content referenced (populated only
  // for XHTML - see `sanitizeXhtml`'s `referencedHrefs`). Used solely to compute the
  // sample-set closure below; never exposed on `ProcessedResource` itself.
  referencedHrefs: string[];
};

function buildResource(archive: SafeArchive, item: ParsedManifestItem, policy: ProcessingPolicy): BuiltResource {
  if (!policy.allowedMediaTypes.has(item.mediaType)) {
    throw new ProcessingError(processingFailure("UNSUPPORTED_MEDIA", `Resource ${item.href} has an unsupported media type: ${item.mediaType}`));
  }

  const rawBytes = archive.entries.get(item.href);
  if (!rawBytes) {
    throw new ProcessingError(processingFailure("INVALID_EPUB", `Manifest item ${item.id} references a missing resource: ${item.href}`));
  }

  let bytes = rawBytes;
  // `ProcessedResource.text` (Task 1's contract) is documented as covering every
  // text-based resource (XHTML, CSS, NCX), but is optional. This processor populates it
  // only for XHTML: that is the one case a consumer needs pre-decoded (verifying
  // sanitization stripped `<script>`/handlers/unsafe URLs without re-parsing `.bytes`
  // itself), and XHTML content documents are typically the smallest text assets in a
  // book. Populating it for every text resource would mean CSS and NCX - along with
  // XHTML - carry a second UTF-8 copy alongside `.bytes` in the same object Task 5's
  // worker passes whole to `complete()`, approaching double peak memory for no
  // consumer that currently needs it (neither Task 5 nor Task 8's brief reads `.text`
  // for anything but inspection/tests). Callers that want CSS/NCX text can decode it
  // from `.bytes` via `decodeText()` above instead of this processor keeping a second
  // copy nothing asked for.
  let text: string | undefined;
  let referencedHrefs: string[] = [];

  if (item.mediaType === XHTML_MEDIA_TYPE) {
    const decoded = textDecoder.decode(rawBytes);
    const sanitized = sanitizeXhtml(decoded, { resourceHref: item.href, policy });
    text = sanitized.html;
    bytes = textEncoder.encode(sanitized.html);
    referencedHrefs = sanitized.referencedHrefs;
  } else if (item.mediaType === CSS_MEDIA_TYPE) {
    // Ruling AZ: a validation scan, not a sanitizer - CSS bytes are stored unmodified,
    // but an external `url()`/`@import` rejects the whole publication the same way an
    // unsafe XHTML reference does, and this is also where the Ruling AW closure reaches
    // `@font-face`-declared fonts (Issue 3) - fonts are otherwise never referenced from
    // XHTML at all.
    const decoded = textDecoder.decode(rawBytes);
    referencedHrefs = scanCss(decoded, { resourceHref: item.href, policy }).referencedHrefs;
    if (setsVerticalWriting(decoded)) {
      throw new ProcessingError(
        processingFailure(
          "UNSUPPORTED_LAYOUT",
          `${item.href} sets vertical writing. Press supports horizontal layout only at launch: re-export the EPUB with horizontal text (remove writing-mode: vertical-*) and upload it again.`,
        ),
      );
    }
  }

  return {
    resource: {
      href: item.href,
      mediaType: item.mediaType,
      byteSize: bytes.byteLength,
      sha256: sha256Hex(bytes),
      // Assigned below, once the full sample closure is known - see
      // `resolveSampleHrefs`.
      accessClass: "paid",
      bytes,
      text,
    },
    referencedHrefs,
  };
}

// Ruling AW: `policy.sampleHrefs` names the sample *documents* (e.g. "give away chapter
// one"), but Task 8's sample route serves only allowlisted hrefs - so a sample document
// whose CSS/images/fonts are not themselves in the allowlist would render unstyled and
// imageless. This expands the caller's candidate set to its transitive closure over
// `referencedHrefs` (collected by `sanitizeXhtml` from every XHTML `href`/`src` it
// validated, and by `scanCss` from every CSS `url()`/`@import` it validated - Issue 3),
// so a sample chapter's stylesheet, cover image, and embedded `@font-face` fonts come
// along with it automatically rather than requiring the caller to hand-enumerate every
// asset a chapter happens to use.
//
// The closure deliberately does NOT cross into another XHTML content document: an
// in-publication `<a href="chapter2.xhtml">` "next chapter" link is a `referencedHref`
// like any other, and following it would let a sample chapter's ordinary navigation link
// pull an entire paid book into the public sample route - exactly the leak this ruling
// warns against. Excluding any referenced resource whose own media type is
// `application/xhtml+xml` from propagation (rather than special-casing the `<a>` tag)
// keeps this correct regardless of which markup carried the reference.
//
// An href that ends up in both a sample and a paid document's `referencedHrefs` (e.g. a
// shared stylesheet) is included: this processor's ruling is that a resource the sample
// already displays should be sample-accessible, and a later paid-chapter reference to the
// same shared asset does not revoke that - it does not disclose anything the sample was
// not already rendering. There is no code path that can remove an href from the set once
// a sample document has pulled it in, so this is closed under the invariant checked below
// (nothing in the result has `accessClass: "paid"`) by construction, not by coincidence.
function resolveSampleHrefs(built: BuiltResource[], policy: ProcessingPolicy): ReadonlySet<string> {
  const resourceByHref = new Map(built.map((entry) => [entry.resource.href, entry.resource]));
  const referencedHrefsByHref = new Map(built.map((entry) => [entry.resource.href, entry.referencedHrefs]));

  const sampleHrefs = new Set([...policy.sampleHrefs].filter((href) => resourceByHref.has(href)));
  const queue = [...sampleHrefs];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const referenced of referencedHrefsByHref.get(current) ?? []) {
      const target = resourceByHref.get(referenced);
      if (!target || target.mediaType === XHTML_MEDIA_TYPE || sampleHrefs.has(referenced)) continue;
      sampleHrefs.add(referenced);
      queue.push(referenced);
    }
  }

  return sampleHrefs;
}

export async function processEpub(bytes: Uint8Array, policy: ProcessingPolicy = DEFAULT_PROCESSING_POLICY): Promise<ProcessedPublication> {
  const archive = openEpubArchive(bytes);
  const parsed = parseEpub(archive);
  const toc = buildToc(archive, parsed);

  const built = parsed.manifest.map((item) => buildResource(archive, item, policy));
  const sampleHrefSet = resolveSampleHrefs(built, policy);

  const resources = built
    .map(({ resource }) => {
      resource.accessClass = sampleHrefSet.has(resource.href) ? "sample" : "paid";
      return resource;
    })
    .sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0));

  // Derived from `resources`, never built independently: Task 8's sample route safety
  // depends on `sampleHrefs` and `resources[].accessClass` agreeing by construction,
  // not by two call sites happening to apply the same rule twice.
  const sampleHrefs = resources.filter((resource) => resource.accessClass === "sample").map((resource) => resource.href);
  const searchIndex = buildSearchIndex({ readingOrder: parsed.readingOrder, resources, toc });

  return {
    metadata: parsed.metadata,
    readingOrder: parsed.readingOrder,
    resources,
    toc,
    sampleHrefs,
    ...searchIndex,
  };
}
