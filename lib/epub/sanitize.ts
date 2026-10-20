// XHTML content-document sanitization. Ruling AG: `sanitize-html` is an HTML sanitizer and
// EPUB content documents are XHTML, so this module configures it for XML-style
// self-closing output and preserves the XHTML namespace - `sanitize.test.ts` asserts a
// sanitized document still parses as XML, not just that the disallowed markup is gone.
import { XMLParser } from "fast-xml-parser";
import sanitizeHtml from "sanitize-html";

import { dirnameOf, externalUrlScheme, hasUnsafeReferenceCharacters, resolveInPublicationReference } from "@/lib/epub/archive";
import { ProcessingError, processingFailure } from "@/lib/epub/errors";
import type { ProcessingPolicy } from "@/lib/epub/types";

function unsafeExternalUrl(message: string): never {
  throw new ProcessingError(processingFailure("UNSAFE_EXTERNAL_URL", message));
}

function invalidEpub(message: string): never {
  throw new ProcessingError(processingFailure("INVALID_EPUB", message));
}

// Used only to prove the content document is well-formed XML with entities disabled
// before handing it to the HTML-oriented sanitizer below - the same XXE/billion-laughs
// defence `parse.ts` applies to container.xml/OPF/NCX (Ruling AF), applied here too since
// content documents are themselves untrusted XHTML. Run on the document exactly as
// authored, *before* `decodeNamedEntities` below touches it: a real "&amp;" is valid XML
// and must stay that way for this check.
const xmlWellFormednessParser = new XMLParser({ processEntities: false, ignoreAttributes: true });

// Ruling BE: an earlier version of this decoder used `@nodable/entities`'s general-purpose
// `EntityDecoder`, configured with a curated table of common HTML/XHTML named entities.
// That library (like every conforming HTML entity decoder - verified `entities@8.1.0`
// behaves identically) unconditionally resolves the five XML-predefined named references
// (`amp`, `lt`, `gt`, `quot`, `apos`) regardless of the table passed to it, because
// resolving them is mandatory decoder behavior, not a configuration choice. Decoding
// before sanitization then means a *correctly XML-escaped* code sample -
// `&lt;script&gt;alert(1)&lt;/script&gt;`, exactly how a technical EPUB marks up a literal
// tag as prose - comes back as a live `<script>` element, which `sanitize-html` then
// strips as content corruption, not a security hole (decoding still precedes
// sanitization), but silent and worse than the `&nbsp;` junk it replaced.
//
// The fix is a fixed table that omits the five by construction, so there is no general
// decoder to reason about at all: `NAMED_ENTITIES` below has no entry for `amp`/`lt`/
// `gt`/`quot`/`apos` (nor their HTML5 uppercase forms `AMP`/`LT`/`GT`), so
// `decodeNamedEntities` never touches those five sequences - they pass through completely
// unchanged, exactly as `sanitize-html`'s own XML-mode parser already handles them
// correctly on its own. This also retires the `@nodable/entities` dependency and its
// ambient type-declaration shim entirely, per the ruling.
//
// Deliberately non-exhaustive: this is the common prose/typography/Latin-1 subset, not
// the full ~250-entry HTML5 named-entity table. An entity outside this set degrades the
// way it always has (survives as literal `&name;` text) rather than failing processing.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  lsaquo: "‹",
  rsaquo: "›",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  prime: "′",
  Prime: "″",
  permil: "‰",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  sect: "§",
  para: "¶",
  micro: "µ",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  curren: "¤",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  ETH: "Ð",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  THORN: "Þ",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  eth: "ð",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  thorn: "þ",
  yuml: "ÿ",
};

const NAMED_ENTITY_PATTERN = /&([a-zA-Z][a-zA-Z0-9]*);/g;

// One linear scan over the original string (`String.replace` never re-scans its own
// output), matching only names that are *own* keys of `NAMED_ENTITIES` above - `amp`/
// `lt`/`gt`/`quot`/`apos`/`AMP`/`LT`/`GT` are not among them, so a well-formed
// `&lt;`/`&gt;`/`&amp;` sequence is untouched by this function under any input, not
// merely in the cases this module's own tests happen to exercise. `Object.hasOwn` (rather
// than `NAMED_ENTITIES[name]` alone) keeps the lookup from walking `Object.prototype`:
// without it, `&constructor;`/`&valueOf;`/`&toString;` resolve to that inherited
// function's own source text instead of falling through to the literal `&name;` every
// other unrecognized entity gets - not a security issue (the injected text has no `<`,
// `&`, or quote characters to escape anything with), but content corruption in the exact
// function written to remove content corruption.
function decodeNamedEntities(text: string): string {
  return text.replace(NAMED_ENTITY_PATTERN, (match, name: string) => (Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match));
}

const ALLOWED_TAGS = [
  "html",
  "head",
  "title",
  "meta",
  "link",
  "body",
  "section",
  "article",
  "nav",
  "header",
  "footer",
  "aside",
  "main",
  "div",
  "span",
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "a",
  "img",
  "figure",
  "figcaption",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "mark",
  "del",
  "ins",
  "wbr",
  "blockquote",
  "q",
  "cite",
  "code",
  "pre",
  "kbd",
  "samp",
  "var",
  "abbr",
  "address",
  "ruby",
  "rt",
  "rp",
];

// `script`, every form element, and every embed/plugin/media element are simply absent
// from this list - sanitize-html discards a tag it was not told to allow, and discards
// `script`/`style` content along with the tag (its default `nonTextTags`), so no separate
// "strip scripts" pass is needed.
//
// Named supported-profile exclusion (spec 8 - processing enforces an explicit supported
// profile, not an implicit one): `style` is deliberately excluded too, not merely
// unhandled. `sanitize-html` is an HTML/attribute sanitizer with no CSS-aware handling of
// `<style>` block content, so keeping the tag would mean either passing raw, unsanitized
// CSS text through untouched (`expression()`, `url(javascript:...)`, `@import` of a
// remote stylesheet - the exact class of executable/external-reference risk this module
// exists to remove from XHTML) or hand-rolling a CSS sanitizer, which is precisely the
// kind of improvised security code this task should not ship. Content documents that use
// inline `<style>` blocks lose them; external stylesheets via `<link rel="stylesheet">`
// are unaffected and are how professionally produced EPUBs overwhelmingly declare CSS.
// This belongs in Task 9's ADR-005 "known supported-profile exclusions" section.
//
// `meta` deliberately excludes `http-equiv`: `<meta http-equiv="refresh"
// content="0;url=https://evil.example">` carries a fully unvalidated URL that navigates
// the rendered document off-publication with no script and no href/src attribute for
// `assertSafeReference` to ever see - EPUB content documents have no legitimate use for
// `http-equiv`, so the attribute is dropped outright rather than taught a `content`-aware
// exception.
// Exported so `sanitize.test.ts` can assert, as a standing guard rather than a one-time
// review finding, that every URL-bearing attribute permitted here has a corresponding
// entry in `URL_BEARING_ATTRIBUTES` below (Critical 1's root cause, not just its
// instance: the `meta`/`http-equiv`/`content` bypass arose from these being two
// independent hand-maintained lists with nothing tying them together).
export const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": ["id", "class", "lang", "xml:lang", "dir", "title", "epub:type", "xmlns", "xmlns:epub"],
  meta: ["charset", "name", "content"],
  link: ["href", "rel", "type", "media"],
  a: ["href"],
  img: ["src", "alt", "width", "height"],
  ol: ["start", "type"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
};

// Every attribute in this list is validated by `assertSafeReference` from inside
// `transformTags` *before* sanitize-html's own scheme filtering ever runs (sanitize-html
// invokes `transformTags` at the top of its open-tag handler), so an unsafe reference
// throws `UNSAFE_EXTERNAL_URL` here rather than being silently stripped by the library and
// passing processing as if the document had never contained it.
export const URL_BEARING_ATTRIBUTES: Record<string, string> = { a: "href", img: "src", link: "href" };

type SanitizeContext = {
  resourceHref: string;
  policy: Pick<ProcessingPolicy, "allowedDataUrlMediaTypes">;
  referenced: Set<string>;
};

function assertSafeReference(value: string, context: SanitizeContext): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return; // empty or same-document fragment

  // Before classifying a scheme at all: a browser's URL parser strips tab/newline/CR
  // characters first, so `java<TAB>script:alert(1)` is executable to a browser even
  // though it defeats `SCHEME_PATTERN`'s naive regex match and would otherwise be
  // classified as a harmless relative path below.
  if (hasUnsafeReferenceCharacters(trimmed)) {
    unsafeExternalUrl(`Reference contains a control character: ${value}`);
  }

  const scheme = externalUrlScheme(trimmed);
  if (scheme === "//") {
    unsafeExternalUrl(`Protocol-relative URL is not allowed in publication content: ${value}`);
  }
  if (scheme !== null) {
    if (scheme === "data") {
      const mediaType = /^data:([^;,]*)[;,]/.exec(trimmed)?.[1]?.toLowerCase();
      if (!mediaType || !context.policy.allowedDataUrlMediaTypes.has(mediaType)) {
        unsafeExternalUrl(`data: URL uses a media type that is not allowlisted: ${value}`);
      }
      return;
    }
    unsafeExternalUrl(`External URL scheme "${scheme}" is not allowed in publication content: ${value}`);
  }

  const resolved = resolveInPublicationReference(dirnameOf(context.resourceHref), trimmed);
  if (resolved === null) {
    unsafeExternalUrl(`Reference escapes the publication: ${value}`);
  }
  context.referenced.add(resolved);
}

export type SanitizedXhtml = {
  html: string;
  // Normalized in-archive paths this document referenced via href/src, collected as a
  // side effect of validating them. `process.ts` can use this to know which shared
  // resources (CSS, images, fonts) a given content document actually needs.
  referencedHrefs: string[];
};

export function sanitizeXhtml(source: string, context: { resourceHref: string; policy: Pick<ProcessingPolicy, "allowedDataUrlMediaTypes"> }): SanitizedXhtml {
  try {
    xmlWellFormednessParser.parse(source, true);
  } catch (error) {
    invalidEpub(`Content document ${context.resourceHref} is not well-formed XML: ${(error as Error).message}`);
  }

  // Decode the named HTML/XHTML entities `sanitize-html`'s XML-mode parser does not
  // recognize (see `NAMED_ENTITIES`'s comment above).
  const decodedSource = decodeNamedEntities(source);

  const referenced = new Set<string>();
  const sanitizeContext: SanitizeContext = { resourceHref: context.resourceHref, policy: context.policy, referenced };

  const transformTags: sanitizeHtml.IOptions["transformTags"] = {};
  for (const [tag, attribute] of Object.entries(URL_BEARING_ATTRIBUTES)) {
    transformTags[tag] = (tagName, attribs) => {
      const value = attribs[attribute];
      if (typeof value === "string") {
        assertSafeReference(value, sanitizeContext);
      }
      return { tagName, attribs };
    };
  }

  const html = sanitizeHtml(decodedSource, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    // Anything that survives `assertSafeReference` above is either a relative
    // in-publication reference (no scheme, so this allowlist never applies to it) or an
    // approved `data:` URL - `data` is listed here only so the library's own scheme
    // filter does not undo an approval we already made.
    allowedSchemes: ["data"],
    allowProtocolRelative: false,
    parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false },
    transformTags,
  });

  return { html, referencedHrefs: [...referenced] };
}

// A validation *scan* over `text/css` resources, not a CSS sanitizer or rewriter (Ruling
// AZ, correcting Ruling AX's assumption that external stylesheets were safe because they
// are unparsed - they ship byte-for-byte, so the same `@import`/remote-`url()` risk AX
// cited as the reason to strip inline `<style>` ships through the "safe" path instead).
// Rejects the same class of unsafe reference `assertSafeReference` rejects in XHTML
// (remote HTTP(S), protocol-relative, non-allowlisted `data:`), and doubles as the source
// of `referencedHrefs` for CSS - `@font-face { src: url(...) }` is essentially the only
// way EPUB fonts are declared, so this is also how the Ruling AW sample closure reaches
// them (Issue 3).
//
// Ruling BM: the previous versions of this scanner applied grammar rules to text without
// first establishing whether that text *was* grammar - it could not tell a declaration
// from a comment from a string. Three consecutive review rounds each closed a real defect
// and introduced a new one, both times from changes that were individually correct against
// the CSS grammar: a mandated `;` terminator fix silently made `@import;` fail *open*, and
// the compensating `@import` fix silently made inert comment prose fail the *whole
// publication*. Those defects came from non-local coupling between rules that cannot be
// enumerated in advance, so correctness of each rule was never the binding constraint;
// coverage of the input space was.
//
// The structural fix is to tokenize first and apply rules only to tokens. `tokenizeCss`
// below is a real CSS Syntax Level 3 tokenizer (https://www.w3.org/TR/css-syntax-3/ 4.3)
// with an explicit state machine over comments, strings, url tokens, escapes and numbers,
// so context is established *before* any rule runs. Comments and strings become single
// opaque tokens that no rule can look inside, which is why `/* use @import for fonts */`
// contributes nothing and cannot fail a publication, and why `content: "url(http://x)"` is
// inert - both by construction rather than by a special case.
//
// The three Ruling BF bypasses stay closed for the same structural reason:
// `@import"https://evil/x.css";` (no whitespace) is an at-keyword token followed by a
// string token; `url('a"b.png')` is a string token whose content is not scanned for
// delimiters; and `\75 rl(` decodes to the `url` keyword because 4.3.4 compares the
// *decoded* name, so it becomes a genuine url token exactly as a browser resolves it.
//
// Fail-closed posture, unchanged: a `<bad-url-token>`, a url token that ran to EOF without
// its `)`, and an `@import` with no readable target are all rejected rather than skipped,
// since an unresolvable reference is exactly the shape a bypass takes. A genuinely empty
// reference (`url()`, `url("")`) remains unambiguous and is silently ignored. A
// `<bad-string-token>` is rejected only where it appears *as a reference target*, not
// wherever it occurs: elsewhere it is an unparseable declaration value that carries no
// reference at all and that a browser simply drops, and failing a whole publication over
// inert junk is the precise defect the `@import` round already had to undo once.
// U+FFFD, the replacement character CSS Syntax 4.3.7 substitutes for a null, surrogate, or
// out-of-range escaped code point.
const REPLACEMENT_CHARACTER = "\uFFFD";

function isCssWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isCssNewline(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === "\f";
}

function isHexDigit(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

// 4.2: an identifier may start with a letter, `_`, or any non-ASCII code point.
function isIdentStartChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch.charCodeAt(0) >= 0x80;
}

function isIdentChar(ch: string): boolean {
  return isIdentStartChar(ch) || isDigit(ch) || ch === "-";
}

// 4.3.6's non-printable set, which makes an unquoted url token a <bad-url-token>.
function isNonPrintable(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
}

// 4.3.8: `\` followed by anything that is not a newline (and not EOF) is a valid escape.
function startsValidEscape(css: string, index: number): boolean {
  if (css[index] !== "\\") return false;
  const next = css[index + 1];
  return next !== undefined && !isCssNewline(next);
}

// 4.3.9: whether the stream at `index` would start an identifier.
function startsIdentifier(css: string, index: number): boolean {
  const ch = css[index];
  if (ch === undefined) return false;
  if (isIdentStartChar(ch)) return true;
  if (ch === "-") {
    const next = css[index + 1];
    if (next === undefined) return false;
    return isIdentStartChar(next) || next === "-" || startsValidEscape(css, index + 1);
  }
  return startsValidEscape(css, index);
}

// 4.3.10: whether the stream at `index` would start a number.
function startsNumber(css: string, index: number): boolean {
  const ch = css[index];
  if (ch === undefined) return false;
  if (ch === "+" || ch === "-") {
    const next = css[index + 1];
    if (next !== undefined && isDigit(next)) return true;
    return next === "." && css[index + 2] !== undefined && isDigit(css[index + 2]);
  }
  if (ch === ".") {
    const next = css[index + 1];
    return next !== undefined && isDigit(next);
  }
  return isDigit(ch);
}

// 4.3.7, entered with `index` on the reverse solidus. A hex escape consumes 1-6 hex digits
// plus one optional trailing whitespace (the escape's own terminator), which is what makes
// `\75 rl` read as `url`; any other character escapes to itself.
function consumeEscape(css: string, index: number): { value: string; end: number } {
  let i = index + 1;
  const first = css[i];
  if (first === undefined) return { value: REPLACEMENT_CHARACTER, end: i };
  if (!isHexDigit(first)) return { value: first, end: i + 1 };

  let hex = "";
  while (i < css.length && hex.length < 6 && isHexDigit(css[i])) {
    hex += css[i];
    i += 1;
  }
  if (i < css.length && isCssWhitespace(css[i])) {
    i += css[i] === "\r" && css[i + 1] === "\n" ? 2 : 1;
  }

  const codePoint = parseInt(hex, 16);
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return { value: REPLACEMENT_CHARACTER, end: i };
  }
  return { value: String.fromCodePoint(codePoint), end: i };
}

// 4.3.12: consume a name, resolving escapes as it goes. The *decoded* result is what 4.3.4
// compares against "url", which is the whole reason an escaped keyword cannot smuggle a
// reference past this scanner.
function consumeName(css: string, index: number): { value: string; end: number } {
  let value = "";
  let i = index;
  while (i < css.length) {
    const ch = css[i];
    if (isIdentChar(ch)) {
      value += ch;
      i += 1;
      continue;
    }
    if (startsValidEscape(css, i)) {
      const escaped = consumeEscape(css, i);
      value += escaped.value;
      i = escaped.end;
      continue;
    }
    break;
  }
  return { value, end: i };
}

// 4.3.13 plus 4.3.3's dimension/percentage suffixes. The value is never used - numbers are
// consumed only so that the tokenizer's cursor stays aligned with the grammar, which is
// what stops `10url(...)` (a dimension whose unit happens to be "url", followed by a
// parenthesis) from being misread as a url token.
function consumeNumeric(css: string, index: number): number {
  let i = index;
  if (css[i] === "+" || css[i] === "-") i += 1;
  while (i < css.length && isDigit(css[i])) i += 1;
  if (css[i] === "." && css[i + 1] !== undefined && isDigit(css[i + 1])) {
    i += 2;
    while (i < css.length && isDigit(css[i])) i += 1;
  }
  if (css[i] === "e" || css[i] === "E") {
    let j = i + 1;
    if (css[j] === "+" || css[j] === "-") j += 1;
    if (css[j] !== undefined && isDigit(css[j])) {
      j += 1;
      while (j < css.length && isDigit(css[j])) j += 1;
      i = j;
    }
  }

  if (startsIdentifier(css, i)) return consumeName(css, i).end; // <dimension-token>
  if (css[i] === "%") return i + 1; // <percentage-token>
  return i;
}

// The token kinds this scanner distinguishes. Everything with no bearing on references -
// numbers, colons, delimiters - collapses into "other"; whitespace and comments are dropped
// entirely, so "the next token" already means "the next meaningful token" and no rule below
// has to re-derive that.
//
// Brackets are tracked rather than collapsed (Ruling CJ): whether a string is a reference
// depends on which function encloses it, so `scanCss` needs to know where every bracket opens
// and closes. "block" is `{` or `}`, which bound that bookkeeping.
//
// "semicolon" is tracked for Ruling CK: an at-rule prelude ends at either `{` or `;`, so `;`
// has to be distinguishable from every other punctuation character to find that boundary.
type CssTokenType =
  | "ident"
  | "function"
  | "at-keyword"
  | "string"
  | "bad-string"
  | "url"
  | "bad-url"
  | "open-paren"
  | "close-paren"
  | "block"
  | "semicolon"
  | "other";

type CssToken = {
  type: CssTokenType;
  // Decoded: escapes resolved, quotes and `url(`/`)` stripped. Empty for structural tokens.
  value: string;
  start: number;
  end: number;
  // For `string` and `url`: whether the token reached its closing delimiter rather than
  // running into EOF. CSS Syntax returns a token either way (an EOF here is only a "parse
  // error"), but for an untrusted reference an unterminated token is unresolvable, so the
  // caller fails closed on it.
  closed: boolean;
};

// 4.3.5. A newline inside a string is a parse error that yields <bad-string-token>, and the
// newline itself is deliberately not consumed.
function consumeStringToken(css: string, index: number): CssToken {
  const quote = css[index];
  let value = "";
  let i = index + 1;

  while (i < css.length) {
    const ch = css[i];
    if (ch === quote) return { type: "string", value, start: index, end: i + 1, closed: true };
    if (isCssNewline(ch)) return { type: "bad-string", value: "", start: index, end: i, closed: false };
    if (ch === "\\") {
      const next = css[i + 1];
      if (next === undefined) {
        i += 1; // a trailing `\` at EOF contributes nothing
        continue;
      }
      if (isCssNewline(next)) {
        i += next === "\r" && css[i + 2] === "\n" ? 3 : 2; // escaped newline: line continuation
        continue;
      }
      const escaped = consumeEscape(css, i);
      value += escaped.value;
      i = escaped.end;
      continue;
    }
    value += ch;
    i += 1;
  }

  return { type: "string", value, start: index, end: i, closed: false };
}

// 4.3.14: skip to the `)` that ends a malformed url token, so tokenizing can resynchronize
// instead of reinterpreting the rest of the stylesheet.
function consumeBadUrlRemnants(css: string, index: number): number {
  let i = index;
  while (i < css.length) {
    if (css[i] === ")") return i + 1;
    if (startsValidEscape(css, i)) {
      i = consumeEscape(css, i).end;
      continue;
    }
    i += 1;
  }
  return i;
}

// 4.3.6, entered just after `url(`. An unquoted url token's content runs to `)`, so `;` is
// ordinary content here - which is what keeps the overwhelmingly common
// `url(data:image/png;base64,...)` spelling parseable and `allowedDataUrlMediaTypes`
// reachable from CSS (Ruling BH).
function consumeUrlToken(css: string, tokenStart: number, contentStart: number): CssToken {
  let i = contentStart;
  while (i < css.length && isCssWhitespace(css[i])) i += 1;

  let value = "";
  while (i < css.length) {
    const ch = css[i];
    if (ch === ")") return { type: "url", value, start: tokenStart, end: i + 1, closed: true };
    if (isCssWhitespace(ch)) {
      while (i < css.length && isCssWhitespace(css[i])) i += 1;
      if (i >= css.length) return { type: "url", value, start: tokenStart, end: i, closed: false };
      if (css[i] === ")") return { type: "url", value, start: tokenStart, end: i + 1, closed: true };
      return { type: "bad-url", value: "", start: tokenStart, end: consumeBadUrlRemnants(css, i), closed: false };
    }
    if (ch === '"' || ch === "'" || ch === "(" || isNonPrintable(ch)) {
      return { type: "bad-url", value: "", start: tokenStart, end: consumeBadUrlRemnants(css, i), closed: false };
    }
    if (ch === "\\") {
      if (startsValidEscape(css, i)) {
        const escaped = consumeEscape(css, i);
        value += escaped.value;
        i = escaped.end;
        continue;
      }
      return { type: "bad-url", value: "", start: tokenStart, end: consumeBadUrlRemnants(css, i), closed: false };
    }
    value += ch;
    i += 1;
  }

  return { type: "url", value, start: tokenStart, end: i, closed: false };
}

// 4.3.4. `url(` with a *quoted* argument is a <function-token> (the string is tokenized
// separately); with an unquoted argument it is a <url-token> read by 4.3.6 above.
function consumeIdentLikeToken(css: string, index: number): CssToken {
  const name = consumeName(css, index);
  const i = name.end;

  if (css[i] !== "(") {
    return { type: "ident", value: name.value, start: index, end: i, closed: true };
  }
  if (name.value.toLowerCase() !== "url") {
    return { type: "function", value: name.value.toLowerCase(), start: index, end: i + 1, closed: true };
  }

  let j = i + 1;
  while (j < css.length && isCssWhitespace(css[j])) j += 1;
  if (css[j] === '"' || css[j] === "'") {
    return { type: "function", value: "url", start: index, end: i + 1, closed: true };
  }
  return consumeUrlToken(css, index, i + 1);
}

// 4.3.1's consume-a-token loop. Whitespace and comments are consumed and dropped rather
// than emitted: nothing downstream needs them, and a comment that is never a token is a
// comment no rule can accidentally read `@import` out of.
function tokenizeCss(css: string): CssToken[] {
  const tokens: CssToken[] = [];
  let i = 0;

  while (i < css.length) {
    const ch = css[i];

    if (isCssWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close === -1 ? css.length : close + 2; // an unterminated comment runs to EOF
      continue;
    }
    if (ch === '"' || ch === "'") {
      const token = consumeStringToken(css, i);
      tokens.push(token);
      i = token.end;
      continue;
    }
    if (ch === "#") {
      // A hash token swallows its name, so `#url(...)` is a hash followed by a parenthesis,
      // never a url token.
      const name = consumeName(css, i + 1);
      tokens.push({ type: "other", value: "", start: i, end: Math.max(name.end, i + 1), closed: true });
      i = Math.max(name.end, i + 1);
      continue;
    }
    if (ch === "@" && startsIdentifier(css, i + 1)) {
      const name = consumeName(css, i + 1);
      tokens.push({ type: "at-keyword", value: name.value.toLowerCase(), start: i, end: name.end, closed: true });
      i = name.end;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "open-paren", value: "", start: i, end: i + 1, closed: true });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "close-paren", value: "", start: i, end: i + 1, closed: true });
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "}") {
      tokens.push({ type: "block", value: "", start: i, end: i + 1, closed: true });
      i += 1;
      continue;
    }
    if (ch === ";") {
      tokens.push({ type: "semicolon", value: "", start: i, end: i + 1, closed: true });
      i += 1;
      continue;
    }
    if (startsNumber(css, i)) {
      const end = consumeNumeric(css, i);
      tokens.push({ type: "other", value: "", start: i, end, closed: true });
      i = end;
      continue;
    }
    if (startsIdentifier(css, i)) {
      const token = consumeIdentLikeToken(css, i);
      tokens.push(token);
      i = token.end;
      continue;
    }

    tokens.push({ type: "other", value: "", start: i, end: i + 1, closed: true });
    i += 1;
  }

  return tokens;
}

// Ruling CJ: `url()` is not the only way CSS names a URL. Several functions take a *bare
// string* that the browser resolves and fetches exactly as if it had been wrapped in `url()`,
// and `image-set("https://evil/x.png" 1x)` contains no `url(` or `@import` substring at all -
// which is why every previous version of this scanner, regex and tokenizer alike, accepted it
// silently. Since CSS ships byte-for-byte, that was a live route to an attacker-controlled
// fetch from every reader's browser.
//
// Derived from the specs, not from the two names the finding happened to mention:
//
//   included - the spec says a bare <string> here IS a <url>
//     image-set()        CSS Images 4: "Each <string> inside image-set() represents a <url>"
//     image()            CSS Images 4: <image-src> = [ <url> | <string> ]
//     src()              CSS Values 4: <url> = <url()> | <src()>, <src()> = src( <string> ... )
//     -webkit-image-set() no spec defines it, but Chrome was *observed fetching it* in a real
//                        browser. Verified required, on the same footing as the entries above -
//                        not a precaution.
//
//   included as a fail-closed guess - no spec, and NOT verified to have ever shipped
//     -moz-image-set(), -o-image-set(), -ms-image-set()
//                        Failing closed on a function nobody implements costs at worst the
//                        rejection of something no browser would have fetched; guessing the
//                        other way costs a bypass. Recorded as a guess so it reads as one.
//
//   excluded - takes a bare string, but the string is NOT a URL. Getting these wrong would
//   corrupt ordinary stylesheets, and three of them sit directly beside `url()`:
//     local()            CSS Fonts 4: local( <font-family-name> ) - an installed font's name
//     format()           a format hint ("woff2"), not a location
//     tech()             font technology keywords
//     type()             CSS Images 4: image-set()'s own type("image/webp") is a MIME type.
//                        This is why the enclosing-function test below is innermost-only.
//
//   excluded - takes no bare string at all
//     cross-fade()       <cf-image> = [ <image> | <color> ] && <percentage>?
//     element()          element( <id-selector> )
//     attr()             takes an attribute name, not a string literal. The binding reason it
//                        is safe is NOT that `sanitizeXhtml` validates the attribute - that
//                        covers only `a.href`, `img.src` and `link.href` (URL_BEARING_ATTRIBUTES
//                        above) and would say nothing about an arbitrary one. It is that
//                        `ALLOWED_ATTRIBUTES` permits no `data-*` attribute at all, so no
//                        attacker-controlled attribute survives sanitization for attr() to read.
//     @font-face src:    a bare string is invalid there - <font-src> requires url()/src() or
//                        local() - so the descriptor itself is not a separate vector
//
// The rule is deliberately keyed on the *enclosing function*, never on strings in general: a
// string is inert unless something says it is a URL. `content: "url(...)"` stays inert for
// exactly that reason.
const URL_BEARING_STRING_FUNCTIONS: ReadonlySet<string> = new Set([
  "image-set",
  "-webkit-image-set",
  "-moz-image-set",
  "-o-image-set",
  "-ms-image-set",
  "image",
  "src",
]);

export function scanCss(source: string, context: { resourceHref: string; policy: Pick<ProcessingPolicy, "allowedDataUrlMediaTypes"> }): { referencedHrefs: string[] } {
  const referenced = new Set<string>();
  const sanitizeContext: SanitizeContext = { resourceHref: context.resourceHref, policy: context.policy, referenced };
  const tokens = tokenizeCss(source);
  const at = (index: number): CssToken | null => (index < tokens.length ? tokens[index] : null);

  // Innermost-first stack of open brackets: `true` where the bracket was opened by a function
  // whose bare string arguments are URLs. Only the innermost entry decides, so the inner string
  // of `image-set("a.png" type("image/webp"))` is judged by `type()` (a MIME type) and not by
  // `image-set()`. Plain `(` pushes a non-URL context so that grouping parens inside a
  // URL-bearing function cannot pop it early.
  const urlBearingBrackets: boolean[] = [];
  const insideUrlBearingFunction = () => urlBearingBrackets.length > 0 && urlBearingBrackets[urlBearingBrackets.length - 1];

  // Ruling CK: true from an at-keyword until the `{` or `;` that ends its prelude. An at-rule
  // prelude is a *condition*, not a value - a browser evaluates it and fetches nothing - so a
  // bare string there is inert. `@import` is the sole construct whose prelude string really is
  // a URL, and it is unaffected by this flag for a structural reason rather than an exception:
  // the at-keyword branch below consumes an `@import` target itself and skips past the token,
  // so that string never reaches the bare-string rule this flag guards.
  let inAtRulePrelude = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    // A <bad-url-token> is a malformed reference, not inert junk: it is the token the
    // grammar produces for `url(` that never resolved. Reject wherever it appears.
    if (token.type === "bad-url") {
      unsafeExternalUrl(`Malformed url() token in CSS near position ${token.start}`);
    }

    if (token.type === "url") {
      if (!token.closed) {
        unsafeExternalUrl(`url() is missing its closing parenthesis near position ${token.start}`);
      }
      if (token.value.length > 0) assertSafeReference(token.value, sanitizeContext);
      continue;
    }

    // The quoted spelling: <function-token> "url(", then a string, then `)`.
    //
    // Ruling CL: neither this branch nor the <url-token> branch above it is prelude-suppressed the
    // way the bare-string rule at the bottom of this loop is (Ruling CK). That asymmetry is
    // load-bearing, not an oversight. `@import url("https://evil/x.css")` is itself a `url()` in an
    // at-rule prelude and it genuinely fetches, so suppressing `url()` in preludes would fail
    // *open* on precisely the hole that cost this file three review rounds.
    //
    // An `inAtRulePrelude` check here could not rescue that: the at-keyword branch below reaches
    // these branches by `continue`, and they have no memory of how they were entered - so one
    // would have to ask "unless we came from @import", reintroducing the exact exception clause
    // Ruling CK's structural fix removed.
    //
    // The residual cost is a false positive: `@supports (background: url("https://…"))` fails a
    // legitimate stylesheet closed. If that is ever worth fixing, the only safe shape is a
    // targeted exemption for known-inert at-rules (`@supports`, `@media`) - never a blanket one.
    if (token.type === "function" && token.value === "url") {
      const target = at(index + 1);
      if (target === null || target.type !== "string" || !target.closed) {
        unsafeExternalUrl(`url() has no readable target near position ${token.start}`);
      }
      const closing = at(index + 2);
      if (closing === null || closing.type !== "close-paren") {
        unsafeExternalUrl(`url() is missing its closing parenthesis near position ${token.start}`);
      }
      if (target.value.length > 0) assertSafeReference(target.value, sanitizeContext);
      index += 2;
      continue;
    }

    if (token.type === "at-keyword") {
      // Every at-rule opens a prelude, `@import` included - the flag is set unconditionally so
      // the boundary bookkeeping has no special cases in it.
      inAtRulePrelude = true;
      if (token.value !== "import") continue;

      // `@import`'s own target handling, unchanged. This is what makes `@import` immune to
      // prelude suppression: the target is resolved *here* and the token skipped, so it is
      // never offered to the bare-string rule at the bottom of this loop.
      const target = at(index + 1);
      if (target === null) {
        unsafeExternalUrl(`@import is missing its target near position ${token.start}`);
      }
      // `@import url(...)` in either spelling is validated by the url/function branches
      // above on the next iteration; nothing to do here but let the loop reach it.
      if (target.type === "url" || (target.type === "function" && target.value === "url")) continue;
      if (target.type !== "string" || !target.closed) {
        unsafeExternalUrl(`@import is missing its target near position ${token.start}`);
      }
      assertSafeReference(target.value, sanitizeContext);
      index += 1;
      continue;
    }

    // Bracket bookkeeping for the string rule below. The `url(` function form is not tracked
    // here because the branch above consumes its string and its `)` outright.
    if (token.type === "function") {
      urlBearingBrackets.push(URL_BEARING_STRING_FUNCTIONS.has(token.value));
      continue;
    }
    if (token.type === "open-paren") {
      urlBearingBrackets.push(false);
      continue;
    }
    if (token.type === "close-paren") {
      urlBearingBrackets.pop();
      continue;
    }
    if (token.type === "block") {
      // `{` or `}` cannot appear inside a function's parentheses in valid CSS, so reaching one
      // means some earlier `(` was never closed. Resynchronize at the rule boundary rather
      // than let a drifting stack make every later string in the file look like a reference.
      // `{` also ends an at-rule prelude, which is why an at-rule's *body* is still scanned
      // normally - suppression covers the condition, never the declarations.
      urlBearingBrackets.length = 0;
      inAtRulePrelude = false;
      continue;
    }
    if (token.type === "semicolon") {
      // The other way a prelude ends: a statement at-rule like `@import …;` or `@charset …;`.
      inAtRulePrelude = false;
      continue;
    }

    // Ruling CJ: a bare string is a reference when - and only when - the function enclosing it
    // says so. Routed through the same `assertSafeReference` a `url()` target takes, so
    // relative references are collected, external and protocol-relative ones rejected, escapes
    // already normalized by the tokenizer, and a `data:` URL still reaches the media-type
    // allowlist.
    //
    // Ruling CK: except in an at-rule prelude, which is a condition rather than a value. A
    // browser evaluates `@supports (background-image: image-set("https://…" 1x))` without
    // fetching anything, so treating that string as a reference both failed the publication
    // outright and, for a relative string, fed a href into the Ruling AW sample closure that
    // names a resource nothing will ever request.
    if (token.type === "string" && insideUrlBearingFunction() && !inAtRulePrelude) {
      if (!token.closed) {
        unsafeExternalUrl(`Unterminated string used as a URL near position ${token.start}`);
      }
      if (token.value.length > 0) assertSafeReference(token.value, sanitizeContext);
      continue;
    }
    if (token.type === "bad-string" && insideUrlBearingFunction() && !inAtRulePrelude) {
      unsafeExternalUrl(`Malformed string used as a URL near position ${token.start}`);
    }
  }

  return { referencedHrefs: [...referenced] };
}
