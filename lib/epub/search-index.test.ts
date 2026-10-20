import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

import { buildSearchIndex, isStructuredSanitizedXhtml } from "@/lib/epub/search-index";
import type { ProcessedResource, ReadingOrderItem, TocEntry } from "@/lib/epub/types";
import type { ReaderLocator } from "@/lib/reader/types";

const XHTML = "application/xhtml+xml";
const encoder = new TextEncoder();

function resource(href: string, mediaType: string, text?: string): ProcessedResource {
  const bytes = encoder.encode(text ?? "");
  return {
    href,
    mediaType,
    byteSize: bytes.byteLength,
    sha256: `fixture-${href}`,
    accessClass: "paid",
    bytes,
    text,
  };
}

const chapterOne = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ignored head title</title></head><body>
  <h1 id="opening">Phần <em>một</em></h1>
  <section id="chapter-one">
    <p id="first">Xin chào <strong>Việt Nam</strong> 😀. Repeat repeat.</p>
    <p id="special:one">Escaped identifier text.</p>
    <p id="duplicate">First duplicate identifier.</p><p id="duplicate">Second duplicate identifier.</p>
    <p>Repeat <em>repeat</em> phrase.</p>
    <blockquote id="quote">Outer container text<p id="quote-line">Quoted <span>nested</span> words.</p>Tail after quote.</blockquote>
    <ul><li>First item</li><li>Second item</li></ul>
    <table><tbody><tr><td>Cell A</td><td>Cell B</td></tr></tbody></table>
    <section id="nested"><p id="nested-line">Deepest section text.</p></section>
  </section>
</body></html>`;

const longParagraph = Array.from({ length: 360 }, (_, index) => `đoạn-${index} 😀`).join(" ");
const chapterTwo = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="long">${longParagraph}</p></body></html>`;

const readingOrder: ReadingOrderItem[] = [
  { href: "OEBPS/text/chapter-1.xhtml", mediaType: XHTML },
  { href: "OEBPS/text/chapter-2.xhtml", mediaType: XHTML },
  { href: "OEBPS/text/empty.xhtml", mediaType: XHTML },
  { href: "OEBPS/text/diagram.xhtml", mediaType: "image/svg+xml" },
];

const toc: TocEntry[] = [
  {
    title: "Part one",
    href: "OEBPS/text/chapter-1.xhtml",
    children: [
      {
        title: "Chapter one",
        href: "OEBPS/text/chapter-1.xhtml#chapter-one",
        children: [{ title: "Deepest section", href: "OEBPS/text/chapter-1.xhtml#nested", children: [] }],
      },
    ],
  },
  { title: "Long chapter", href: "OEBPS/text/chapter-2.xhtml#long", children: [] },
];

type ParsedNode = {
  tag: string;
  attributes: Record<string, string>;
  children: Array<ParsedNode | string>;
};

const orderedXmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributesGroupName: ":@",
  textNodeName: "#text",
  processEntities: false,
  trimValues: false,
});

function toParsedNode(entry: Record<string, unknown>): ParsedNode {
  const [tag] = Object.keys(entry).filter((key) => key !== ":@");
  const children = entry[tag] as Array<Record<string, unknown>>;
  const attributes = ((entry[":@"] as Record<string, string> | undefined) ?? {});
  const parsedChildren: Array<ParsedNode | string> = [];
  for (const child of children) {
    if (typeof child["#text"] === "string") parsedChildren.push(child["#text"]);
    else parsedChildren.push(toParsedNode(child));
  }
  return {
    tag,
    attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.replace(/^@_/, ""), value])),
    children: parsedChildren,
  };
}

function parseOriginalXhtml(xhtml: string): ParsedNode {
  const entries = orderedXmlParser.parse(xhtml, true) as Array<Record<string, unknown>>;
  const html = entries.find((entry) => "html" in entry);
  if (!html) throw new Error("fixture must contain an html element");
  return toParsedNode(html);
}

function normalizedText(node: ParsedNode): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : normalizedText(child)))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function descendants(node: ParsedNode): ParsedNode[] {
  return [node, ...node.children.flatMap((child) => (typeof child === "string" ? [] : descendants(child)))];
}

function selectOriginalNode(root: ParsedNode, selector: string): ParsedNode | undefined {
  if (selector.startsWith("#")) {
    const id = selector.slice(1).replace(/\\([\da-f]{1,6})\s?/giu, (_, codePoint: string) => String.fromCodePoint(Number.parseInt(codePoint, 16)));
    return descendants(root).find((node) => node.attributes.id === id);
  }

  if (selector.startsWith(":root")) {
    let current: ParsedNode | undefined = root;
    for (const segment of selector.split(" > ").slice(1)) {
      const match = /^\*:nth-child\((\d+)\)$/u.exec(segment);
      if (!match || !current) return undefined;
      const children: ParsedNode[] = current.children.filter((child): child is ParsedNode => typeof child !== "string");
      current = children[Number(match[1]) - 1];
    }
    return current;
  }

  let current: ParsedNode | undefined = root;
  for (const [segmentIndex, segment] of selector.split(">").entries()) {
    const match = /^([\w:-]+):nth-of-type\((\d+)\)$/u.exec(segment);
    if (!match || !current) return undefined;
    const [, tag, index] = match;
    if (segmentIndex === 0 && current.tag === tag && index === "1") continue;
    const siblings: ParsedNode[] = current.children.filter((child): child is ParsedNode => typeof child !== "string" && child.tag === tag);
    current = siblings[Number(index) - 1];
  }
  return current;
}

function resolveDomAnchor(xhtml: string, locator: ReaderLocator): string | undefined {
  const selector = locator.locations.cssSelector;
  const highlight = locator.text?.highlight;
  if (typeof selector !== "string" || !highlight) return undefined;
  const document = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  const element = document.querySelector(selector);
  if (!element) return undefined;
  const points = Array.from((element.textContent ?? "").replace(/\s+/gu, " ").trim());
  const offset = locator.locations.textOffset;
  if (typeof offset !== "number") return undefined;
  const before = locator.text?.before ?? "";
  const after = locator.text?.after ?? "";
  const quote = points.slice(offset, offset + Array.from(highlight).length).join("");
  if (
    quote !== highlight ||
    points.slice(Math.max(0, offset - Array.from(before).length), offset).join("") !== before ||
    points.slice(offset + Array.from(highlight).length, offset + Array.from(highlight).length + Array.from(after).length).join("") !== after
  ) {
    return undefined;
  }
  return quote;
}

function resolveQuotedAnchor(root: ParsedNode, locator: ReaderLocator): string | undefined {
  const selector = locator.locations.cssSelector;
  const highlight = locator.text?.highlight;
  if (typeof selector !== "string" || !highlight) return undefined;

  const text = normalizedText(selectOriginalNode(root, selector) ?? root);
  const textOffset = locator.locations.textOffset;
  if (typeof textOffset === "number") {
    const points = Array.from(text);
    const quotePoints = Array.from(highlight);
    const before = locator.text?.before ?? "";
    const after = locator.text?.after ?? "";
    const candidate = points.slice(textOffset, textOffset + quotePoints.length).join("");
    if (
      candidate === highlight &&
      points.slice(Math.max(0, textOffset - Array.from(before).length), textOffset).join("") === before &&
      points.slice(textOffset + quotePoints.length, textOffset + quotePoints.length + Array.from(after).length).join("") === after
    ) {
      return candidate;
    }
    return undefined;
  }

  let start = text.indexOf(highlight);
  while (start !== -1) {
    const before = locator.text?.before ?? "";
    const after = locator.text?.after ?? "";
    if (text.slice(Math.max(0, start - before.length), start) === before && text.slice(start + highlight.length, start + highlight.length + after.length) === after) {
      return text.slice(start, start + highlight.length);
    }
    start = text.indexOf(highlight, start + 1);
  }
  return undefined;
}

describe("buildSearchIndex", () => {
  it("accepts an empty XHTML body but rejects invalid document and body structure", () => {
    expect(isStructuredSanitizedXhtml("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body/></html>")).toBe(true);
    expect(isStructuredSanitizedXhtml("<html><body/></html><foo/>")).toBe(false);
    expect(isStructuredSanitizedXhtml("<html><body><body/></body></html>")).toBe(false);
    expect(isStructuredSanitizedXhtml("<html><head><body/></head><body/></html>")).toBe(false);
  });

  it("derives repeatable searchable XHTML blocks and original-document quote anchors", () => {
    const resources = [
      resource("OEBPS/text/chapter-1.xhtml", XHTML, chapterOne),
      resource("OEBPS/text/chapter-2.xhtml", XHTML, chapterTwo),
      resource("OEBPS/text/empty.xhtml", XHTML, "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body/></html>"),
      resource("OEBPS/styles/book.css", "text/css", ".hidden { content: 'CSS MUST NOT BE INDEXED'; }"),
      resource("OEBPS/text/diagram.xhtml", "image/svg+xml", "<svg><text>SVG MUST NOT BE INDEXED</text></svg>"),
    ];
    const originalBytes = resources.map((entry) => Array.from(entry.bytes));
    const originalResourceMetadata = resources.map(({ href, mediaType, byteSize, sha256, accessClass, text }) => ({ href, mediaType, byteSize, sha256, accessClass, text }));
    const input = { readingOrder, resources, toc };

    const first = buildSearchIndex(input);

    expect(buildSearchIndex(input)).toEqual(first);
    expect(first.searchChunks.map((row) => row.ordinal)).toEqual(first.searchChunks.map((_, index) => index));
    expect(first.searchChunks.every((row) => Array.from(row.plainText).length <= 1024)).toBe(true);
    expect(resources.map((entry) => Array.from(entry.bytes))).toEqual(originalBytes);
    expect(resources.map(({ href, mediaType, byteSize, sha256, accessClass, text }) => ({ href, mediaType, byteSize, sha256, accessClass, text }))).toEqual(
      originalResourceMetadata,
    );

    expect(first.searchChunks.map((row) => row.plainText)).toContain("Xin chào Việt Nam 😀. Repeat repeat.");
    expect(first.searchChunks.map((row) => row.plainText)).toContain("Outer container text");
    expect(first.searchChunks.map((row) => row.plainText)).toContain("Quoted nested words.");
    expect(first.searchChunks.map((row) => row.plainText)).toContain("Tail after quote.");
    expect(first.searchChunks.map((row) => row.plainText).join(" ")).not.toContain("Outer container textQuoted nested words.");
    expect(first.searchChunks.map((row) => row.plainText).join(" ")).not.toContain("Ignored head title");
    expect(first.searchChunks.map((row) => row.plainText).join(" ")).not.toContain("CSS MUST NOT BE INDEXED");
    expect(first.searchChunks.map((row) => row.plainText).join(" ")).not.toContain("SVG MUST NOT BE INDEXED");

    const firstParagraph = first.searchChunks.find((row) => row.plainText === "Xin chào Việt Nam 😀. Repeat repeat.");
    const nestedParagraph = first.searchChunks.find((row) => row.plainText === "Deepest section text.");
    const escapedIdentifier = first.searchChunks.find((row) => row.plainText === "Escaped identifier text.");
    const duplicateIdentifier = first.searchChunks.find((row) => row.plainText === "First duplicate identifier.");
    expect(firstParagraph?.chapterTitle).toBe("Chapter one");
    expect(firstParagraph?.locator.locations.cssSelector).toBe("#first");
    expect(nestedParagraph?.chapterTitle).toBe("Deepest section");
    expect(escapedIdentifier?.locator.locations.cssSelector).toBe("#special\\3a one");
    expect(duplicateIdentifier?.locator.locations.cssSelector).not.toBe("#duplicate");

    const originalDocuments = new Map([
      ["OEBPS/text/chapter-1.xhtml", parseOriginalXhtml(chapterOne)],
      ["OEBPS/text/chapter-2.xhtml", parseOriginalXhtml(chapterTwo)],
    ]);
    for (const row of first.searchChunks) {
      const document = originalDocuments.get(row.href);
      expect(document, `missing original document for ${row.href}`).toBeDefined();
      expect(resolveQuotedAnchor(document as ParsedNode, row.locator)).toBe(row.locator.text?.highlight);
      expect(Array.from(row.locator.text?.highlight ?? "").length).toBeLessThanOrEqual(160);
      expect(Array.from(row.locator.text?.before ?? "").length).toBeLessThanOrEqual(64);
      expect(Array.from(row.locator.text?.after ?? "").length).toBeLessThanOrEqual(64);
    }
  });

  it("emits one-based positions at resource starts and long-text boundaries", () => {
    const resources = [
      resource("OEBPS/text/chapter-1.xhtml", XHTML, chapterOne),
      resource("OEBPS/text/chapter-2.xhtml", XHTML, chapterTwo),
      resource("OEBPS/text/empty.xhtml", XHTML, "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body/></html>"),
      resource("OEBPS/text/diagram.xhtml", "image/svg+xml", "<svg><text>ignored</text></svg>"),
    ];

    const result = buildSearchIndex({ readingOrder, resources, toc });
    const positions = result.positions;
    expect(positions.map((locator) => locator.locations.position)).toEqual(positions.map((_, index) => index + 1));
    expect(positions.filter((locator) => locator.href === "OEBPS/text/chapter-2.xhtml")).toHaveLength(Math.floor(Array.from(longParagraph).length / 1024) + 1);
    expect(positions.some((locator) => locator.href === "OEBPS/text/empty.xhtml")).toBe(true);
    expect(positions.some((locator) => locator.href === "OEBPS/text/diagram.xhtml")).toBe(true);

    const original = parseOriginalXhtml(chapterTwo);
    for (const locator of positions.filter((entry) => entry.href === "OEBPS/text/chapter-2.xhtml")) {
      expect(resolveQuotedAnchor(original, locator)).toBe(locator.text?.highlight);
      expect(locator.totalProgression).toBeGreaterThanOrEqual(0);
      expect(locator.totalProgression).toBeLessThanOrEqual(1);
    }
  });

  it("uses a code-point text offset with quote context to resolve repeated text in one element", () => {
    const repeatedText = "abcdefgh".repeat(600);
    const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="repeated">${repeatedText}</p></body></html>`;
    const href = "OEBPS/text/repeated.xhtml";
    const result = buildSearchIndex({
      readingOrder: [{ href, mediaType: XHTML }],
      resources: [resource(href, XHTML, xhtml)],
      toc: [],
    });
    const [, second, third] = result.searchChunks;

    expect(second.plainText).toBe(third.plainText);
    expect(second.locator.text).toEqual(third.locator.text);
    expect(second.locator.locations.textOffset).toBe(1024);
    expect(third.locator.locations.textOffset).toBe(2048);

    const original = parseOriginalXhtml(xhtml);
    expect(resolveQuotedAnchor(original, second.locator)).toBe(second.locator.text?.highlight);
    expect(resolveQuotedAnchor(original, third.locator)).toBe(third.locator.text?.highlight);
  });

  it("matches DOM-visible entities, wrapper text, fragment chapter ranges, and namespace-safe selectors", () => {
    const href = "OEBPS/text/prefixed.xhtml";
    const xhtml = `<xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml"><xhtml:body>
      <xhtml:header>Intro <xhtml:em>wrapped</xhtml:em><xhtml:p>Body &amp; &#x1F600;</xhtml:p>Tail</xhtml:header>
      <xhtml:h1 id="chapter-two">Chapter two heading</xhtml:h1><xhtml:p>Sibling chapter text.</xhtml:p>
      <xhtml:ul><xhtml:li>First list item</xhtml:li><xhtml:li>Second list item</xhtml:li></xhtml:ul>
      <xhtml:table><xhtml:tbody><xhtml:tr><xhtml:td>Table cell</xhtml:td></xhtml:tr></xhtml:tbody></xhtml:table>
      <xhtml:script>Script text must not be indexed.</xhtml:script><xhtml:style>Style text must not be indexed.</xhtml:style>
      <xhtml:h1 id="next">Next heading</xhtml:h1><xhtml:p>Next chapter sibling.</xhtml:p>
    </xhtml:body></xhtml:html>`;
    const result = buildSearchIndex({
      readingOrder: [{ href, mediaType: XHTML }],
      resources: [resource(href, XHTML, xhtml)],
      toc: [
        { title: "Chapter two", href: `${href}#chapter-two`, children: [] },
        { title: "Next chapter", href: `${href}#next`, children: [] },
      ],
    });
    const texts = result.searchChunks.map((chunk) => chunk.plainText);

    expect(texts).toEqual([
      "Intro wrapped",
      "Body & 😀",
      "Tail",
      "Chapter two heading",
      "Sibling chapter text.",
      "First list item",
      "Second list item",
      "Table cell",
      "Next heading",
      "Next chapter sibling.",
    ]);
    expect(texts.filter((text) => text === "Intro wrapped")).toHaveLength(1);
    expect(texts.join(" ")).not.toContain("Script text must not be indexed.");
    expect(texts.join(" ")).not.toContain("Style text must not be indexed.");
    expect(result.searchChunks.find((chunk) => chunk.plainText === "Sibling chapter text.")?.chapterTitle).toBe("Chapter two");
    expect(result.searchChunks.find((chunk) => chunk.plainText === "Next chapter sibling.")?.chapterTitle).toBe("Next chapter");
    expect(result.searchChunks.every((chunk) => !String(chunk.locator.locations.cssSelector).includes("xhtml:"))).toBe(true);
    for (const chunk of result.searchChunks) expect(resolveDomAnchor(xhtml, chunk.locator)).toBe(chunk.locator.text?.highlight);
  });
});

// A PDF-to-EPUB export lays every page out with absolutely positioned <div>s and starts a new
// one at every font change - so a single word is split across elements, mid-word. The real
// book that exposed this produced 37,499 chunks from 265,962 characters: a median chunk of
// one character, and not one chunk containing a whole word for full-text search to match.
describe("buildSearchIndex with PDF-export positional markup", () => {
  const positionalPage = (body: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="page">${body}</div></body></html>`;

  function chunksFor(xhtml: string) {
    const href = "OEBPS/page1.xhtml";
    return buildSearchIndex({
      readingOrder: [{ href, mediaType: XHTML }],
      resources: [resource(href, XHTML, xhtml)],
      toc: [],
    }).searchChunks;
  }

  const d = (text: string) => `<div class="t" style="left:48px;top:78px">${text}</div>`;

  it("rejoins a word the exporter split across positioned divs", () => {
    const chunks = chunksFor(positionalPage(`${d("Trong tr")}${d("ạ")}${d("ng")}${d(" thái")}`));

    expect(chunks.map((row) => row.plainText)).toEqual(["Trong trạng thái"]);
  });

  it("keeps a separator the exporter emitted as its own whitespace-only div", () => {
    const chunks = chunksFor(positionalPage(`${d("292")}${d(" ")}${d("| ")}${d("Vươn mình")}`));

    expect(chunks.map((row) => row.plainText)).toEqual(["292 | Vươn mình"]);
  });

  it("anchors a merged chunk to its first member div, with a quote that still resolves there", () => {
    const xhtml = positionalPage(`${d("Trong tr")}${d("ạ")}${d("ng")}`);
    const [chunk] = chunksFor(xhtml);

    expect(resolveQuotedAnchor(parseOriginalXhtml(xhtml), chunk.locator)).toBe(chunk.locator.text?.highlight);
    expect(chunk.locator.text?.highlight).toBe("Trong tr");
  });

  it("never lets a merged run exceed the 1024 code-point chunk limit", () => {
    const chunks = chunksFor(positionalPage(Array.from({ length: 400 }, (_, index) => d(`từ${index} `)).join("")));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((row) => Array.from(row.plainText).length <= 1024)).toBe(true);
    expect(chunks.map((row) => row.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  it("leaves a div that is already big enough to search on its own standalone", () => {
    const long = "câu văn đủ dài để tự nó là một đơn vị tìm kiếm ".repeat(6);
    const chunks = chunksFor(positionalPage(`${d(long)}${d(long)}`));

    expect(chunks).toHaveLength(2);
  });

  // The whole point of restricting merging to <div>: p/li/td/h* each assert a distinct unit,
  // so they stay individually addressable no matter how short they are.
  it("never merges semantic blocks, however short", () => {
    const chunks = chunksFor(
      `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><ul><li>First item</li><li>Second item</li></ul><p>A</p><p>B</p></body></html>`,
    );

    expect(chunks.map((row) => row.plainText)).toEqual(["First item", "Second item", "A", "B"]);
  });
});
