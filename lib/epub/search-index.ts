// Extracts search blocks and stable navigation positions from the already-sanitized
// XHTML processor output. This module deliberately has no storage, framework, DOM, or
// reader-engine runtime dependency: Task 3 decides where this neutral output is stored.
import { XMLParser } from "fast-xml-parser";

import type {
  ProcessedResource,
  ProcessedSearchChunk,
  ProcessedSearchIndex,
  ReadingOrderItem,
  TocEntry,
} from "@/lib/epub/types";
import type { ReaderLocator } from "@/lib/reader/types";

const XHTML_MEDIA_TYPE = "application/xhtml+xml";
const SEARCH_CHUNK_CODE_POINTS = 1024;
// A <div> longer than this already stands on its own as a searchable unit, so it is never
// merged. Only runs of divs below it - the signature of a PDF export that starts a new
// positioned element at every font change - are joined back together.
const MERGEABLE_BLOCK_CODE_POINTS = 200;
const QUOTE_CODE_POINTS = 160;
const CONTEXT_CODE_POINTS = 64;

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "td",
  "th",
  "tr",
  "ul",
]);

const EXCLUDED_TAGS = new Set(["head", "noscript", "script", "style", "template"]);

const orderedXhtmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributesGroupName: ":@",
  textNodeName: "#text",
  processEntities: false,
  parseTagValue: false,
  trimValues: false,
});

type XmlChild = XmlElement | string;

type XmlElement = {
  tag: string;
  attributes: Record<string, string>;
  children: XmlChild[];
  parent: XmlElement | null;
};

type NormalizedText = {
  text: string;
  // Whether the raw source text had whitespace at each boundary. `text` itself is trimmed, so
  // this is the only surviving evidence of whether two adjacent blocks were separated in the
  // source at all - which is what decides whether merging them may glue two words together.
  leadingWhitespace: boolean;
  trailingWhitespace: boolean;
};

type ExtractedBlock = {
  element: XmlElement;
  // `text` is the searchable, non-overlapping portion of a semantic block. A
  // parent block with nested blocks can therefore contribute its own visible text
  // without indexing its children's words a second time.
  text: NormalizedText;
  anchorText: NormalizedText;
  anchorOffset: number;
  selector: string;
  chapterTitle: string | null;
  start: number;
  // `<div>` is the one tag in BLOCK_TAGS that asserts nothing about its contents; p, li, td,
  // h1-h6 and the rest each declare a distinct unit and must stay individually addressable
  // however short they are. So only leaf divs are ever merge candidates.
  mergeable: boolean;
  // Whether the source separated this block from the previous one by any whitespace - either
  // its own, the previous block's, or a whitespace-only block dropped in between. A PDF
  // export splits mid-word with no whitespace at all ("Trong tr" + "ạ" + "ng"), so joining on
  // this fact is what rebuilds real words instead of "Trong tr ạ ng".
  separatedFromPrevious: boolean;
};

type ResourceExtraction = {
  href: string;
  blocks: ExtractedBlock[];
  textLength: number;
  bookStart: number;
};

type FlatTocEntry = {
  title: string;
  href: string;
  fragment: string | null;
  depth: number;
  order: number;
};

const XML_PREDEFINED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// `processEntities: false` prevents parser-level entity expansion, which is necessary
// for untrusted XML. Sanitized XHTML text still contains the five XML predefined
// entities and numeric character references, though, while the browser DOM exposes
// their characters. Decode only those safe references at the text-node boundary;
// unknown names remain literal and cannot trigger arbitrary entity expansion.
function decodeVisibleXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));/giu, (reference, entity: string) => {
    if (!entity.startsWith("#")) return XML_PREDEFINED_ENTITIES[entity.toLowerCase()] ?? reference;
    const numeric = entity.slice(1);
    const codePoint = numeric.startsWith("x") || numeric.startsWith("X") ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return reference;
    }
    return String.fromCodePoint(codePoint);
  });
}

function localName(tag: string): string {
  const separator = tag.indexOf(":");
  return (separator === -1 ? tag : tag.slice(separator + 1)).toLowerCase();
}

function entryToElement(entry: Record<string, unknown>, parent: XmlElement | null): XmlElement | null {
  const tag = Object.keys(entry).find((key) => key !== ":@" && key !== "#text");
  if (!tag) return null;

  const rawAttributes = entry[":@"];
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    (rawAttributes && typeof rawAttributes === "object" ? rawAttributes : {}) as Record<string, unknown>,
  )) {
    if (typeof value === "string") attributes[name.replace(/^@_/, "")] = value;
  }
  const element: XmlElement = { tag, attributes, children: [], parent };
  const rawChildren = entry[tag];
  if (!Array.isArray(rawChildren)) return element;

  for (const rawChild of rawChildren) {
    if (!rawChild || typeof rawChild !== "object") continue;
    const child = rawChild as Record<string, unknown>;
    if (typeof child["#text"] === "string") {
      element.children.push(decodeVisibleXmlEntities(child["#text"]));
      continue;
    }
    const childElement = entryToElement(child, element);
    if (childElement) element.children.push(childElement);
  }
  return element;
}

function parseSanitizedXhtml(xhtml: string): XmlElement | null {
  const entries = orderedXhtmlParser.parse(xhtml, true) as Array<Record<string, unknown>>;
  const documentRoots = entries.flatMap((entry) =>
    Object.keys(entry)
      .filter((key) => key !== ":@" && key !== "#text" && !key.startsWith("?") && !key.startsWith("!"))
      .map((key) => ({ entry, key })),
  );
  if (documentRoots.length !== 1 || localName(documentRoots[0].key) !== "html") return null;
  return entryToElement(documentRoots[0].entry, null);
}

function descendants(element: XmlElement): XmlElement[] {
  return [element, ...element.children.flatMap((child) => (typeof child === "string" ? [] : descendants(child)))];
}

// Backfill consumes previously stored derived bytes rather than running the sanitizer again.
// Validate their minimum XHTML document shape before extraction so a corrupt object cannot turn a
// real index into a successful, empty replacement.
export function isStructuredSanitizedXhtml(xhtml: string): boolean {
  try {
    const root = parseSanitizedXhtml(xhtml);
    if (root === null || localName(root.tag) !== "html") return false;
    const bodies = descendants(root).filter((element) => localName(element.tag) === "body");
    return bodies.length === 1 && bodies[0].parent === root;
  } catch {
    return false;
  }
}

function collectTextNodes(element: XmlElement, output: string[]): void {
  if (EXCLUDED_TAGS.has(localName(element.tag))) return;
  if (localName(element.tag) === "br") {
    output.push(" ");
    return;
  }
  for (const child of element.children) {
    if (typeof child === "string") output.push(child);
    else collectTextNodes(child, output);
  }
}

function normalizeRawText(raw: string): NormalizedText {
  const normalized: string[] = [];
  let pendingWhitespace = false;
  let leadingWhitespace = false;

  for (const codePoint of raw) {
    if (/\s/u.test(codePoint)) {
      pendingWhitespace = true;
      if (normalized.length === 0) leadingWhitespace = true;
    } else {
      if (pendingWhitespace && normalized.length > 0) {
        normalized.push(" ");
      }
      pendingWhitespace = false;
      normalized.push(codePoint);
    }
  }

  return { text: normalized.join(""), leadingWhitespace, trailingWhitespace: pendingWhitespace };
}

function normalizeText(element: XmlElement): NormalizedText {
  const rawParts: string[] = [];
  collectTextNodes(element, rawParts);
  return normalizeRawText(rawParts.join(""));
}

function hasBlockDescendant(element: XmlElement): boolean {
  for (const child of element.children) {
    if (typeof child === "string") continue;
    if (BLOCK_TAGS.has(localName(child.tag)) || hasBlockDescendant(child)) return true;
  }
  return false;
}

function containsBlock(element: XmlElement): boolean {
  return BLOCK_TAGS.has(localName(element.tag)) || hasBlockDescendant(element);
}

function collectTextOutsideBlocks(element: XmlElement, output: string[]): void {
  if (EXCLUDED_TAGS.has(localName(element.tag))) return;
  if (BLOCK_TAGS.has(localName(element.tag))) {
    output.push(" ");
    return;
  }
  if (localName(element.tag) === "br") {
    output.push(" ");
    return;
  }
  for (const child of element.children) {
    if (typeof child === "string") output.push(child);
    else collectTextOutsideBlocks(child, output);
  }
}

function collectReadableBlocks(element: XmlElement, output: Array<Pick<ExtractedBlock, "element" | "text" | "anchorText" | "anchorOffset" | "mergeable">>): void {
  if (EXCLUDED_TAGS.has(localName(element.tag))) return;
  const isBlock = BLOCK_TAGS.has(localName(element.tag));
  const hasNestedBlock = hasBlockDescendant(element);
  if (!isBlock && !hasNestedBlock) return;

  const anchorText = normalizeText(element);
  if (isBlock && !hasNestedBlock) {
    output.push({ element, text: anchorText, anchorText, anchorOffset: 0, mergeable: localName(element.tag) === "div" });
    return;
  }

  // A block may have visible direct text before, between, or after nested blocks:
  // `<li>intro<p>nested</p>tail</li>` is three visible pieces, not just `nested`.
  // Flush those parent-owned pieces in document order, while each nested block is
  // traversed separately. The anchor offset is found in the full original element
  // text so its quote context still disambiguates the actual source location.
  const anchorPoints = codePoints(anchorText.text);
  let anchorCursor = 0;
  let directParts: string[] = [];
  const flushDirectText = () => {
    const text = normalizeRawText(directParts.join(""));
    directParts = [];
    if (text.text.length === 0) return;
    const points = codePoints(text.text);
    const offset = anchorPoints.findIndex((_, index) => index >= anchorCursor && anchorPoints.slice(index, index + points.length).join("") === text.text);
    const anchorOffset = offset === -1 ? anchorCursor : offset;
    output.push({ element, text, anchorText, anchorOffset, mergeable: false });
    anchorCursor = anchorOffset + points.length;
  };

  for (const child of element.children) {
    if (typeof child === "string") {
      directParts.push(child);
      continue;
    }
    if (!containsBlock(child)) {
      collectTextOutsideBlocks(child, directParts);
      continue;
    }
    flushDirectText();
    const childText = normalizeText(child).text;
    const childPoints = codePoints(childText);
    const childOffset = anchorPoints.findIndex(
      (_, index) => index >= anchorCursor && anchorPoints.slice(index, index + childPoints.length).join("") === childText,
    );
    if (childOffset !== -1) anchorCursor = childOffset + childPoints.length;
    collectReadableBlocks(child, output);
  }
  flushDirectText();
}

function idCounts(root: XmlElement): Map<string, number> {
  const counts = new Map<string, number>();
  for (const element of descendants(root)) {
    const id = element.attributes.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function cssIdentifier(id: string): string {
  const points = codePoints(id);
  return points
    .map((point, index) => {
      const isAsciiLetter = /^[A-Za-z]$/u.test(point);
      const isDigit = /^[0-9]$/u.test(point);
      const isSafeNameCharacter = isAsciiLetter || isDigit || point === "_" || point === "-" || point.codePointAt(0)! >= 0x80;
      const mustEscape = !isSafeNameCharacter || (index === 0 && isDigit) || (index === 1 && isDigit && points[0] === "-");
      return mustEscape ? `\\${point.codePointAt(0)?.toString(16)} ` : point;
    })
    .join("");
}

function structuralSelector(element: XmlElement, uniqueIds: Map<string, number>): string {
  const id = element.attributes.id;
  if (id && uniqueIds.get(id) === 1) return `#${cssIdentifier(id)}`;

  const ancestry: XmlElement[] = [];
  for (let current: XmlElement | null = element; current; current = current.parent) ancestry.push(current);
  ancestry.reverse();
  // Parser qualified names (for example `xhtml:p`) are not browser CSS selectors.
  // A wildcard element-child path is namespace-safe, valid in `querySelector`, and
  // remains deterministic without inventing a namespace prefix binding.
  return ancestry.reduce((selector, entry, index) => {
    if (index === 0) return ":root";
    const elementSiblings = entry.parent?.children.filter((sibling): sibling is XmlElement => typeof sibling !== "string") ?? [];
    return `${selector} > *:nth-child(${elementSiblings.indexOf(entry) + 1})`;
  }, "");
}

function flattenToc(entries: TocEntry[], depth = 0, state = { order: 0 }): FlatTocEntry[] {
  return entries.flatMap((entry) => {
    const hash = entry.href.indexOf("#");
    const fragment = hash === -1 ? null : decodeURIComponent(entry.href.slice(hash + 1));
    const current: FlatTocEntry = {
      title: entry.title,
      href: hash === -1 ? entry.href : entry.href.slice(0, hash),
      fragment: fragment || null,
      depth,
      order: state.order++,
    };
    return [current, ...flattenToc(entry.children, depth + 1, state)];
  });
}

function chapterTitleForBlock(
  href: string,
  element: XmlElement,
  toc: FlatTocEntry[],
  elementOrder: Map<XmlElement, number>,
  idOrder: Map<string, number>,
): string | null {
  const currentOrder = elementOrder.get(element);
  if (currentOrder === undefined) return null;
  let match: FlatTocEntry | null = null;
  for (const entry of toc) {
    if (entry.href !== href) continue;
    if (entry.fragment !== null) {
      const targetOrder = idOrder.get(entry.fragment);
      if (targetOrder === undefined || targetOrder > currentOrder) continue;
      const isSuperseded = toc.some((candidate) => {
        if (candidate.href !== href || candidate.fragment === null || candidate.depth > entry.depth) return false;
        const candidateOrder = idOrder.get(candidate.fragment);
        return candidateOrder !== undefined && candidateOrder > targetOrder && candidateOrder <= currentOrder;
      });
      if (isSuperseded) continue;
    }
    if (!match || entry.depth > match.depth || (entry.depth === match.depth && entry.order > match.order)) match = entry;
  }
  return match?.title ?? null;
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function quoteLocator(input: {
  href: string;
  selector: string;
  text: string;
  offset: number;
  progression: number;
  totalProgression: number;
  position?: number;
}): ReaderLocator {
  const points = codePoints(input.text);
  const highlight = points.slice(input.offset, input.offset + QUOTE_CODE_POINTS).join("");
  const before = points.slice(Math.max(0, input.offset - CONTEXT_CODE_POINTS), input.offset).join("");
  const after = points.slice(input.offset + codePoints(highlight).length, input.offset + codePoints(highlight).length + CONTEXT_CODE_POINTS).join("");
  // `textOffset` is a zero-based Unicode-code-point offset into the selector
  // element's full visible text. That text is formed by concatenating visible text
  // nodes, collapsing each Unicode-whitespace run to one ASCII space, and trimming
  // whitespace at the element's boundaries. It is an anchor hint only: consumers
  // must still verify the bounded quote and its before/after context at this offset.
  const locations: ReaderLocator["locations"] = { cssSelector: input.selector, textOffset: input.offset };
  if (input.position !== undefined) locations.position = input.position;

  return {
    href: input.href,
    progression: input.progression,
    totalProgression: input.totalProgression,
    locations,
    text: { before, highlight, after },
  };
}

function resourceExtractions(input: {
  readingOrder: ReadingOrderItem[];
  resources: ProcessedResource[];
  toc: FlatTocEntry[];
}): ResourceExtraction[] {
  const resources = new Map(input.resources.map((resource) => [resource.href, resource]));
  const extractions: ResourceExtraction[] = [];
  let bookStart = 0;

  for (const item of input.readingOrder) {
    const resource = resources.get(item.href);
    const blocks: ExtractedBlock[] = [];
    if (item.mediaType === XHTML_MEDIA_TYPE && resource?.mediaType === XHTML_MEDIA_TYPE && resource.text !== undefined) {
      const root = parseSanitizedXhtml(resource.text);
      const body = root ? descendants(root).find((element) => localName(element.tag) === "body") : undefined;
      if (body) {
        const uniqueIds = idCounts(root as XmlElement);
        const documentElements = descendants(root as XmlElement);
        const elementOrder = new Map(documentElements.map((element, index) => [element, index]));
        const idOrder = new Map<string, number>();
        for (const [element, order] of elementOrder) {
          if (element.attributes.id && !idOrder.has(element.attributes.id)) idOrder.set(element.attributes.id, order);
        }
        const readableBlocks: Array<Pick<ExtractedBlock, "element" | "text" | "anchorText" | "anchorOffset" | "mergeable">> = [];
        collectReadableBlocks(body, readableBlocks);
        let start = 0;
        // A block whose visible text is entirely whitespace contributes nothing to search,
        // but it is still a separator in the source - the PDF export emits the space between
        // two words as its own <div>. Carry that fact to the next real block instead of
        // losing it with the block.
        let whitespaceSincePreviousBlock = false;
        for (const readableBlock of readableBlocks) {
          const { element, text, anchorText, anchorOffset, mergeable } = readableBlock;
          if (text.text.length === 0) {
            whitespaceSincePreviousBlock ||= text.leadingWhitespace || text.trailingWhitespace;
            continue;
          }
          const previous = blocks[blocks.length - 1];
          blocks.push({
            element,
            text,
            anchorText,
            anchorOffset,
            selector: structuralSelector(element, uniqueIds),
            chapterTitle: chapterTitleForBlock(item.href, element, input.toc, elementOrder, idOrder),
            start,
            mergeable,
            separatedFromPrevious: whitespaceSincePreviousBlock || text.leadingWhitespace || (previous?.text.trailingWhitespace ?? false),
          });
          whitespaceSincePreviousBlock = false;
          start += codePoints(text.text).length;
        }
      }
    }
    const textLength = blocks.reduce((total, block) => total + codePoints(block.text.text).length, 0);
    extractions.push({ href: item.href, blocks, textLength, bookStart });
    bookStart += textLength;
  }
  return extractions;
}

// Joins a run of blocks the way the source separated them: with a space only where the
// source actually had whitespace. A PDF export splits mid-word with none, so "Trong tr" +
// "ạ" + "ng" has to rejoin as "Trong trạng" for any word search to ever match it.
function mergedGroupText(group: ExtractedBlock[]): string {
  return group.reduce((text, block, index) => (index === 0 ? block.text.text : text + (block.separatedFromPrevious ? " " : "") + block.text.text), "");
}

// Groups consecutive leaf divs that are each too small to search on their own. Requiring the
// same parent keeps a run inside one container, and the 1024 cap means a merged group is
// always emitted as exactly one chunk - so the per-element offset arithmetic the locator
// depends on is only ever used on an unmerged block.
function groupBlocksForChunking(blocks: ExtractedBlock[]): ExtractedBlock[][] {
  const groups: ExtractedBlock[][] = [];
  for (const block of blocks) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    const isShort = codePoints(block.text.text).length < MERGEABLE_BLOCK_CODE_POINTS;
    const canMerge =
      current !== undefined &&
      previous !== undefined &&
      block.mergeable &&
      previous.mergeable &&
      isShort &&
      codePoints(previous.text.text).length < MERGEABLE_BLOCK_CODE_POINTS &&
      block.element.parent === previous.element.parent &&
      codePoints(mergedGroupText([...current, block])).length <= SEARCH_CHUNK_CODE_POINTS;
    if (canMerge) current.push(block);
    else groups.push([block]);
  }
  return groups;
}

function blockAtOffset(blocks: ExtractedBlock[], offset: number): ExtractedBlock | undefined {
  return blocks.find((block) => {
    const end = block.start + codePoints(block.text.text).length;
    return offset >= block.start && offset < end;
  });
}

export function buildSearchIndex(input: {
  readingOrder: ReadingOrderItem[];
  resources: ProcessedResource[];
  toc: TocEntry[];
}): ProcessedSearchIndex {
  const toc = flattenToc(input.toc);
  const extractions = resourceExtractions({ ...input, toc });
  const bookTextLength = extractions.reduce((total, resource) => total + resource.textLength, 0);
  const searchChunks: ProcessedSearchChunk[] = [];
  const positions: ReaderLocator[] = [];
  let ordinal = 0;

  for (const resource of extractions) {
    for (const group of groupBlocksForChunking(resource.blocks)) {
      const block = group[0];
      // A merged group is one chunk whose text spans several elements, so its locator anchors
      // to the first member - a real element whose own visible text still contains the quote
      // at `textOffset`. `textOffset` is documented as an anchor hint that consumers verify,
      // and the excerpt a reader sees comes from `plainText`, not from the quote.
      const points = group.length > 1 ? codePoints(mergedGroupText(group)) : codePoints(block.text.text);
      for (let offset = 0; offset < points.length; offset += SEARCH_CHUNK_CODE_POINTS) {
        const plainText = points.slice(offset, offset + SEARCH_CHUNK_CODE_POINTS).join("");
        const resourceOffset = block.start + offset;
        searchChunks.push({
          href: resource.href,
          chapterTitle: block.chapterTitle,
          ordinal: ordinal++,
          plainText,
          locator: quoteLocator({
            href: resource.href,
            selector: block.selector,
            text: block.anchorText.text,
            offset: block.anchorOffset + offset,
            progression: resource.textLength === 0 ? 0 : resourceOffset / resource.textLength,
            totalProgression: bookTextLength === 0 ? 0 : (resource.bookStart + resourceOffset) / bookTextLength,
          }),
        });
      }
    }

    const offsets = [0];
    for (let offset = SEARCH_CHUNK_CODE_POINTS; offset < resource.textLength; offset += SEARCH_CHUNK_CODE_POINTS) offsets.push(offset);
    for (const offset of offsets) {
      const block = blockAtOffset(resource.blocks, offset);
      const position = positions.length + 1;
      if (!block) {
        positions.push({
          href: resource.href,
          progression: 0,
          totalProgression: bookTextLength === 0 ? 0 : resource.bookStart / bookTextLength,
          locations: { position },
        });
        continue;
      }
      positions.push(
        quoteLocator({
          href: resource.href,
          selector: block.selector,
          text: block.anchorText.text,
          offset: block.anchorOffset + offset - block.start,
          progression: resource.textLength === 0 ? 0 : offset / resource.textLength,
          totalProgression: bookTextLength === 0 ? 0 : (resource.bookStart + offset) / bookTextLength,
          position,
        }),
      );
    }
  }

  return { searchChunks, positions };
}
