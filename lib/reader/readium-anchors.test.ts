import { describe, expect, it } from "vitest";

import { anchorForRange, domRangePoint, verifiedRange } from "@/lib/reader/readium-anchors";
import type { ReaderLocator } from "@/lib/reader/types";

const base: ReaderLocator = { href: "chapter.xhtml", progression: 0, totalProgression: null, locations: {} };

describe("adapter-local text anchors", () => {
  function documentWith(html: string) {
    return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
  }

  it("resolves the later identical quote using normalized code points across inline markup and BR", () => {
    const doc = documentWith('<p id="p">😀  same <em>quote</em>.<br/>same <em>quote</em>.</p>');
    const locator = { ...base, locations: { cssSelector: "#p", textOffset: 14 }, text: { highlight: "same quote.", before: "😀 same quote. ", after: "" } };
    const range = verifiedRange(doc, locator)!;
    expect(range).not.toBeNull();
    expect(range.startContainer).toBe(doc.querySelector("p")!.childNodes[4]);
    expect(range.startOffset).toBe(0);
    expect(range.toString()).toBe("same quote.");
  });

  it("rejects an ambiguous legacy quote and verifies offset context before resolving", () => {
    const doc = documentWith('<p id="p">repeat repeat</p>');
    expect(verifiedRange(doc, { ...base, text: { highlight: "repeat" } })).toBeNull();
    expect(verifiedRange(doc, { ...base, locations: { cssSelector: "#p", textOffset: 7 }, text: { highlight: "repeat", before: "bad" } })).toBeNull();
    expect(verifiedRange(doc, { ...base, locations: { cssSelector: "#p", textOffset: 7 }, text: { highlight: "repeat", before: "repeat " } })?.startOffset).toBe(7);
  });

  it("round-trips a selected later passage while retaining bounded context", () => {
    const doc = documentWith('<p id="p">😀 repeat repeat end</p>');
    const range = doc.createRange();
    range.setStart(doc.querySelector("p")!.firstChild!, 10);
    range.setEnd(doc.querySelector("p")!.firstChild!, 16);
    const anchor = anchorForRange(base.href, range, base)!;
    expect(anchor.locations).toEqual({ cssSelector: "#p", textOffset: 9 });
    expect(anchor.text).toEqual({ before: "😀 repeat ", highlight: "repeat", after: " end" });
    expect(verifiedRange(doc, anchor)?.startOffset).toBe(10);
  });

  it("round-trips selection in the second element with a duplicate publisher ID", () => {
    const doc = documentWith('<p id="duplicate">Repeated passage.</p><p id="duplicate">Repeated passage.</p>');
    const selectedText = doc.querySelectorAll("p")[1].firstChild!;
    const selection = doc.createRange();
    selection.selectNodeContents(selectedText);

    const anchor = anchorForRange(base.href, selection, base)!;
    const resolved = verifiedRange(doc, anchor);

    expect(resolved?.startContainer).toBe(selectedText);
    expect(resolved?.endContainer).toBe(selectedText);
    expect(resolved?.toString()).toBe("Repeated passage.");
  });

  it("keeps decoration endpoints on the structurally resolved element with duplicate IDs on it and its ancestors", () => {
    const doc = documentWith('<section id="duplicate"><p id="passage">Repeated <em id="word">passage.</em></p></section><section id="duplicate"><p id="passage">Repeated <em id="word">passage.</em></p></section>');
    const paragraph = doc.querySelectorAll("p")[1];
    const emphasis = paragraph.querySelector("em")!;
    const range = verifiedRange(doc, {
      ...base,
      locations: { cssSelector: "html > body > section:nth-of-type(2) > p", textOffset: 0 },
      text: { highlight: "Repeated passage." },
    })!;
    expect(range.startContainer).toBe(paragraph.firstChild);
    expect(range.endContainer).toBe(emphasis.firstChild);

    const start = domRangePoint(range.startContainer, range.startOffset);
    const end = domRangePoint(range.endContainer, range.endOffset);

    expect(doc.querySelector(start.cssSelector)).toBe(paragraph);
    expect(doc.querySelectorAll(start.cssSelector)).toHaveLength(1);
    expect(doc.querySelector(end.cssSelector)).toBe(emphasis);
    expect(doc.querySelectorAll(end.cssSelector)).toHaveLength(1);
    expect(start).toMatchObject({ textNodeIndex: 0, charOffset: 0 });
    expect(end).toMatchObject({ textNodeIndex: 0, charOffset: 8 });
  });

  it.each(["#duplicate", "p"])("rejects ambiguous incoming selector %s even when quote and context match", (cssSelector) => {
    const doc = documentWith('<p id="duplicate">Repeated passage.</p><p id="duplicate">Repeated passage.</p>');
    expect(verifiedRange(doc, {
      ...base,
      locations: { cssSelector, textOffset: 0 },
      text: { highlight: "Repeated passage.", before: "", after: "" },
    })).toBeNull();
  });
});
