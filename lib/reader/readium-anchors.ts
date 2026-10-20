import type { ReaderLocator } from "@/lib/reader/types";

type TextPoint = { node: Text; offset: number };
type MappedCharacter = { value: string; start: TextPoint; end: TextPoint };

// Matches the extractor: Unicode code points, collapsed whitespace, BR as a space,
// no inserted spaces between inline elements. DOM offsets themselves are UTF-16.
function mappedText(element: Element): MappedCharacter[] {
  const result: MappedCharacter[] = [];
  let pending: MappedCharacter | undefined;
  function visit(node: Node) {
    if (node.nodeType === 3) {
      const text = node as Text;
      let offset = 0;
      for (const value of text.data) {
        const character = { value, start: { node: text, offset }, end: { node: text, offset: offset + value.length } };
        offset += value.length;
        if (/\s/u.test(value)) {
          pending = pending ? { ...pending, end: character.end } : { ...character, value: " " };
        } else {
          if (pending && result.length) result.push(pending);
          pending = undefined;
          result.push(character);
        }
      }
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (["head", "noscript", "script", "style", "template"].includes(child.localName)) return;
      if (child.localName === "br") {
        const prior = result.at(-1);
        if (prior) pending = { value: " ", start: prior.end, end: prior.end };
        return;
      }
      for (const nested of child.childNodes) visit(nested);
    }
  }
  visit(element);
  return result;
}

function selectorFor(element: Element): string {
  // nth-of-type also works with namespaces in XHTML. Only a unique publisher ID
  // identifies this element; duplicate IDs also require structural ancestor paths.
  if (element.id && /^[A-Za-z_][\w-]*$/.test(element.id)) {
    const matches = element.ownerDocument.querySelectorAll(`#${element.id}`);
    if (matches.length === 1 && matches[0] === element) return `#${element.id}`;
  }
  const parent = element.parentElement;
  if (!parent) return element.localName;
  const index = Array.from(parent.children).filter((sibling) => sibling.localName === element.localName).indexOf(element) + 1;
  return `${selectorFor(parent)} > ${element.localName}:nth-of-type(${index})`;
}

export function verifiedRange(doc: Document, locator: ReaderLocator): Range | null {
  try {
    const selector = locator.locations.cssSelector;
    const roots = typeof selector === "string" ? doc.querySelectorAll(selector) : [doc.body];
    if (roots.length !== 1) return null;
    const root = roots[0];
    if (!root || !locator.text?.highlight) return null;
    const mapped = mappedText(root);
    const points = mapped.map((item) => item.value);
    const quote = Array.from(locator.text.highlight);
    const before = Array.from(locator.text.before ?? "");
    const after = Array.from(locator.text.after ?? "");
    function matches(offset: number) {
      return points.slice(offset, offset + quote.length).join("") === quote.join("") &&
        points.slice(Math.max(0, offset - before.length), offset).join("") === before.join("") &&
        points.slice(offset + quote.length, offset + quote.length + after.length).join("") === after.join("");
    }
    let offset = locator.locations.textOffset;
    if (offset !== undefined) {
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || !matches(offset)) return null;
    } else {
      const matchesAt = points.flatMap((_, index) => matches(index) ? [index] : []);
      // An ambiguous legacy quote is unresolved, never silently the first occurrence.
      if (matchesAt.length !== 1) return null;
      offset = matchesAt[0];
    }
    const start = mapped[offset]?.start;
    const end = mapped[offset + quote.length - 1]?.end;
    if (!start || !end) return null;
    const range = doc.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch { return null; }
}

export function domRangePoint(node: Node, offset: number) {
  const parent = node.parentElement!;
  return {
    cssSelector: selectorFor(parent),
    textNodeIndex: Array.from(parent.childNodes).filter((child) => child.nodeType === 3).indexOf(node as Text),
    charOffset: offset,
  };
}

export function anchorForRange(href: string, range: Range, base: ReaderLocator, maximum = 1000): ReaderLocator | null {
  const ancestor = range.commonAncestorContainer;
  const root = ancestor.nodeType === 1 ? ancestor as Element : ancestor.parentElement;
  if (!root) return null;
  const mapped = mappedText(root);
  const offset = mapped.findIndex((item) => range.comparePoint(item.start.node, item.start.offset) >= 0);
  if (offset < 0) return null;
  let end = offset;
  while (end < mapped.length && range.comparePoint(mapped[end].end.node, mapped[end].end.offset) <= 0) end++;
  end = Math.min(end, offset + maximum);
  const text = mapped.map((item) => item.value);
  if (end <= offset) return null;
  return {
    ...base, href, locations: { cssSelector: selectorFor(root), textOffset: offset },
    text: {
      highlight: text.slice(offset, end).join(""),
      before: text.slice(Math.max(0, offset - 64), offset).join(""),
      after: text.slice(end, end + 64).join(""),
    },
  };
}
