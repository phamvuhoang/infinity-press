import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROCESSING_POLICY } from "@/lib/epub/process";
import { ALLOWED_ATTRIBUTES, sanitizeXhtml, scanCss, URL_BEARING_ATTRIBUTES } from "@/lib/epub/sanitize";

// Attribute names that carry a URL somewhere in the HTML/XML spec (not just the ones this
// module currently permits) - used below to guard Critical 1's *root cause*, not just its
// instance: a future tag/attribute added to `ALLOWED_ATTRIBUTES` without a matching entry
// in `URL_BEARING_ATTRIBUTES` is exactly how the `meta`/`http-equiv` bypass arose.
const KNOWN_URL_BEARING_ATTRIBUTE_NAMES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "cite",
  "poster",
  "data",
  "background",
  "longdesc",
  "profile",
  "usemap",
  "ping",
  "codebase",
  "archive",
]);

const policy = { allowedDataUrlMediaTypes: DEFAULT_PROCESSING_POLICY.allowedDataUrlMediaTypes };
const context = { resourceHref: "OEBPS/text/chapter1.xhtml", policy };

function parsesAsXml(xml: string): boolean {
  try {
    new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml, true);
    return true;
  } catch {
    return false;
  }
}

describe("sanitizeXhtml", () => {
  it("removes <script> tags and their content", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<script>alert("pwned")</script>
<p>Safe text.</p>
</body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
    expect(html).toContain("Safe text.");
  });

  it("removes inline event-handler attributes", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p onclick="alert(1)">Click me</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).not.toContain("onclick");
    expect(html).toContain("Click me");
  });

  it("removes form and embed-style elements", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<form action="https://example.com"><input type="text"/></form>
<iframe src="https://example.com"></iframe>
<object data="evil.swf"></object>
<p>Safe text.</p>
</body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).toContain("Safe text.");
  });

  it("rejects a remote https:// reference", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="https://example.com/evil.png" alt="x"/></body></html>`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
  });

  it("rejects a protocol-relative reference", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="//example.com/evil.png" alt="x"/></body></html>`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
  });

  it("rejects a javascript: URL", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><a href="javascript:alert(1)">Click</a></body></html>`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
  });

  it("rejects a data: URL whose media type is not allowlisted", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="data:application/octet-stream;base64,AAAA" alt="x"/></body></html>`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
  });

  it("permits a data: URL whose media type is allowlisted", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="data:image/png;base64,AAAA" alt="x"/></body></html>`;

    const { html } = sanitizeXhtml(source, context);
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("permits and resolves a relative in-publication reference", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="../images/cover.jpg" alt="x"/></body></html>`;

    const { html, referencedHrefs } = sanitizeXhtml(source, context);
    expect(html).toContain("../images/cover.jpg");
    expect(referencedHrefs).toEqual(["OEBPS/images/cover.jpg"]);
  });

  it("rejects a relative reference that escapes the publication root", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><a href="../../../../etc/passwd">x</a></body></html>`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
  });

  // Ruling AG: the output must still be valid XHTML, not merely HTML with the dangerous
  // parts removed.
  it("produces output that still parses as well-formed XML", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>
<p>Line one.<br/>Line two.</p>
<hr/>
<img src="../images/cover.jpg" alt="Cover"/>
</body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(parsesAsXml(html)).toBe(true);
  });

  it("preserves the XHTML namespace on the root element", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Text.</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });

  it("self-closes void elements instead of leaving an HTML-style unclosed tag", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>One<br/>Two</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).not.toMatch(/<br>(?!<\/br>)/);
    expect(html).toContain("<br");
    expect(parsesAsXml(html)).toBe(true);
  });

  it("rejects a content document that is not well-formed XML", () => {
    const source = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Unclosed`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  // Critical 1: a meta refresh carries a fully unvalidated URL through the sanitizer with
  // no script and no href/src attribute for `assertSafeReference` to ever see. Without
  // `http-equiv="refresh"`, no browser interprets `content` as a redirect directive at
  // all - the attribute itself, not scrubbing the URL-shaped text it happens to contain,
  // is what makes the tag inert.
  it("strips http-equiv from <meta>, so a meta-refresh cannot navigate the document at all", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="refresh" content="0;url=https://evil.example/steal"/></head><body><p>Safe text.</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("refresh");
  });

  it("still allows <meta charset>, which carries no URL", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/></head><body><p>Safe text.</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).toContain('charset="utf-8"');
  });

  // Important 5: `&nbsp;`/`&mdash;`/etc. are valid only via the XHTML DTD, not in strict
  // XML, so sanitize-html's XML-mode parser does not recognize them and re-escapes the
  // bare `&` it leaves behind - turning `a&nbsp;b` into the visibly wrong `a&amp;nbsp;b`.
  it("decodes named HTML/XHTML entities instead of corrupting them into visible junk", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a&nbsp;b, a&mdash;b</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).not.toContain("&amp;nbsp;");
    expect(html).not.toContain("&amp;mdash;");
    expect(html).toContain("a b");
    expect(html).toContain("a—b");
  });

  it("still treats a real escaped ampersand as valid XML and round-trips it correctly", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Tom &amp; Jerry</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).toContain("Tom &amp; Jerry");
    expect(parsesAsXml(html)).toBe(true);
  });

  // Ruling BE: the previous entity decoder resolved the five XML-predefined entities
  // unconditionally (mandatory behavior for every conforming HTML entity decoder, not a
  // configuration mistake), so a correctly-escaped code sample like this one - exactly how
  // a technical EPUB marks up a literal tag as prose - came back as a live element and was
  // then stripped as markup, silently deleting the example. The fixed table must never
  // decode `&lt;`/`&gt;` at all, so the escaped text survives as prose.
  it("never decodes &lt;/&gt;, so an escaped code sample survives as text instead of being reintroduced as markup", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(parsesAsXml(html)).toBe(true);
  });

  it("never decodes &lt;/&gt; even in ordinary prose", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>if a &lt; b then a &gt; 0 is false</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).toContain("a &lt; b");
    expect(html).toContain("a &gt; 0");
  });

  // Minor (round 3): `NAMED_ENTITIES[name]` alone walks the prototype chain, so
  // `&constructor;`/`&valueOf;` would otherwise resolve to that inherited function's own
  // source text instead of falling through to the literal `&name;` every other
  // unrecognized entity gets.
  it("does not resolve an entity name through Object.prototype", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>&constructor;/&valueOf;/&hasOwnProperty;</p></body></html>`;

    const { html } = sanitizeXhtml(source, context);

    expect(html).toContain("&amp;constructor;");
    expect(html).toContain("&amp;valueOf;");
    expect(html).toContain("&amp;hasOwnProperty;");
    expect(html).not.toContain("native code");
  });

  // Minor 7: a browser strips tab/newline/CR before classifying a scheme, so this reference
  // is executable to a browser even though it defeats a naive scheme regex.
  it("rejects a reference containing a control character, before scheme classification", () => {
    const source = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><a href="java&#9;script:alert(1)">Click</a></body></html>`;

    expect(() => sanitizeXhtml(source, context)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
  });
});

// Out-of-scope observation from the round-1 re-review: close Critical 1's root cause, not
// just its instance. `ALLOWED_ATTRIBUTES` and `URL_BEARING_ATTRIBUTES` are two independent
// hand-maintained lists - this test fails the moment a future URL-bearing attribute is
// added to the first without a matching entry in the second, which is exactly how the
// `meta`/`http-equiv`/`content` bypass arose.
describe("ALLOWED_ATTRIBUTES / URL_BEARING_ATTRIBUTES consistency", () => {
  it("has a URL_BEARING_ATTRIBUTES entry for every known URL-bearing attribute permitted anywhere in ALLOWED_ATTRIBUTES", () => {
    for (const [tag, attributes] of Object.entries(ALLOWED_ATTRIBUTES!)) {
      if (!Array.isArray(attributes)) continue;
      for (const attribute of attributes) {
        const name = typeof attribute === "string" ? attribute : attribute.name;
        if (!KNOWN_URL_BEARING_ATTRIBUTE_NAMES.has(name)) continue;
        if (tag === "*") {
          // URL_BEARING_ATTRIBUTES maps one specific tag to one attribute name - it has
          // no way to express "every tag". A URL-bearing attribute permitted globally
          // would need that routing mechanism extended, not silently pass this guard.
          throw new Error(`"${name}" is a known URL-bearing attribute permitted for every tag ("*") - route it through assertSafeReference for every tag it can appear on.`);
        }
        expect(URL_BEARING_ATTRIBUTES[tag]).toBe(name);
      }
    }
  });
});

describe("scanCss", () => {
  const cssContext = { resourceHref: "OEBPS/styles/style.css", policy };

  it("permits and collects a relative in-publication url()", () => {
    const { referencedHrefs } = scanCss('@font-face { src: url(../fonts/body.woff2); }', cssContext);
    expect(referencedHrefs).toEqual(["OEBPS/fonts/body.woff2"]);
  });

  it("permits and collects a relative @import target", () => {
    const { referencedHrefs } = scanCss('@import "base.css";', cssContext);
    expect(referencedHrefs).toEqual(["OEBPS/styles/base.css"]);
  });

  it("rejects an external url()", () => {
    expect(() => scanCss("body { background: url(https://tracker.example/pixel.png); }", cssContext)).toThrow(
      expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
    );
  });

  it("rejects an external @import", () => {
    expect(() => scanCss('@import url("https://tracker.example/x.css");', cssContext)).toThrow(
      expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
    );
  });

  it("rejects a protocol-relative url()", () => {
    expect(() => scanCss("body { background: url(//tracker.example/pixel.png); }", cssContext)).toThrow(
      expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
    );
  });

  it("ignores a url() with no target and CSS with no references at all", () => {
    expect(scanCss("body { color: red; }", cssContext).referencedHrefs).toEqual([]);
  });

  // Ruling BF: three constructs the previous two-regex scan silently missed entirely
  // (fail-open), all ordinary or trivially obfuscated CSS, all a route to a remote
  // reference the scan exists to close.
  describe("fail-closed on constructs the previous scan silently missed (Ruling BF)", () => {
    it("rejects @import with no whitespace before the target (ordinary valid CSS)", () => {
      expect(() => scanCss('@import"https://tracker.example/x.css";', cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("rejects url() whose quoted string contains the opposite quote character literally", () => {
      // The string is single-quoted; the double quote inside it is ordinary content, not
      // a terminator - a naive `[^'")]` exclusion class misses this reference entirely.
      expect(() => scanCss("body { background: url('https://tracker.example/a\"b.png'); }", cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("still correctly extracts a relative reference with an opposite quote character inside it", () => {
      const { referencedHrefs } = scanCss("body { background: url('a\"b.png'); }", cssContext);
      expect(referencedHrefs).toEqual(["OEBPS/styles/a\"b.png"]);
    });

    it("rejects a url() token spelled with a CSS escape sequence", () => {
      // `\75` is hex for "u"; the trailing space is the escape's own terminator, so this
      // reads as `url(...)` to a real CSS engine.
      expect(() => scanCss("body { background: \\75 rl(https://tracker.example/p.png); }", cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("rejects an unterminated url() rather than silently ignoring it", () => {
      // Fails closed via the missing-closing-paren check (the `;` is ordinary unquoted
      // token content, not a terminator - see the Ruling BH describe block below - so
      // this is no longer "unterminated because of the `;`"; it is unterminated because
      // there truly is no `)` anywhere before the next token boundary).
      expect(() => scanCss("body { background: url(https://tracker.example/p.png; }", cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("rejects a url() with no closing paren before the end of the stylesheet", () => {
      expect(() => scanCss("body { background: url(https://tracker.example/p.png", cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("rejects an @import with no resolvable target rather than silently ignoring it", () => {
      expect(() => scanCss("@import;", cssContext)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
    });
  });

  // Ruling BM: the scanner now tokenizes before applying any rule, so a construct that only
  // *looks* like a reference cannot be read as one. These three all failed the entire
  // publication under the previous scan, which matched `@import`/`url(` as bare text with no
  // notion of comment or string context - the second and third are the same defect as the
  // first, one context over.
  describe("establishes context before applying rules (Ruling BM)", () => {
    it("does not read an @import out of comment prose", () => {
      expect(() => scanCss("/* use @import for fonts */", cssContext)).not.toThrow();
      expect(scanCss("/* use @import for fonts */", cssContext).referencedHrefs).toEqual([]);
    });

    it("does not read a url() out of a commented-out declaration", () => {
      const css = "/* body { background: url(https://tracker.example/pixel.png); } */";
      expect(() => scanCss(css, cssContext)).not.toThrow();
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    it("does not read a url() out of a string that merely contains one", () => {
      // A quoted `content` value is literal text - no browser fetches it - so this is inert
      // prose, not a reference, and must not fail the publication.
      const css = 'body::after { content: "url(https://tracker.example/pixel.png)"; }';
      expect(() => scanCss(css, cssContext)).not.toThrow();
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    it("still rejects a real url() that follows inert comment prose", () => {
      // Guards the obvious over-correction: skipping comments must not skip what comes after.
      expect(() => scanCss("/* @import is fine here */ body { background: url(https://tracker.example/p.png); }", cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });
  });

  // Ruling BH: the Ruling BF fix over-corrected by treating `;` as an unquoted-token
  // terminator, which is wrong per CSS Syntax (an unquoted url-token's content runs to
  // `)`; `;` inside it is ordinary data) - rejecting the overwhelmingly common unquoted
  // spelling of an embedded `data:` image/font, and making
  // `policy.allowedDataUrlMediaTypes` unreachable from CSS entirely. Round 1 accepted all
  // of these; they must again.
  describe("does not reject ordinary unquoted url() content containing a semicolon (Ruling BH)", () => {
    it("permits an unquoted data: URL whose media type is allowlisted", () => {
      const { referencedHrefs } = scanCss("body { background: url(data:image/png;base64,iVBORw0KGgo=); }", cssContext);
      expect(referencedHrefs).toEqual([]); // a data: URL has no in-publication href to collect
    });

    it("still rejects an unquoted data: URL whose media type is not allowlisted", () => {
      expect(() => scanCss("body { background: url(data:application/octet-stream;base64,AAAA); }", cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("correctly parses an unquoted @font-face data: URL up to its policy check (font/woff2 is not itself data-URL-allowlisted)", () => {
      // The point of this case is the parse, not the policy outcome: it must reach
      // `assertSafeReference`'s media-type check at all, rather than being rejected
      // earlier as an "unterminated" token because of the semicolon before `base64`.
      //
      // Asserting the code alone could not tell those two apart - every rejection on this
      // path carries UNSAFE_EXTERNAL_URL, so the test passed just as happily when the
      // semicolon truncated the token and the *missing-paren* branch raised instead. The
      // exact message is the discriminator: only a parse that carried the whole url token
      // through to the media-type check can name the full `data:font/woff2;base64,AAAA`.
      // A truncating parse yields either a missing-paren message or one naming a
      // `data:font/woff2` cut short at the semicolon.
      expect(() => scanCss("@font-face { src: url(data:font/woff2;base64,AAAA) format('woff2'); }", cssContext)).toThrow(
        expect.objectContaining({
          code: "UNSAFE_EXTERNAL_URL",
          message: "data: URL uses a media type that is not allowlisted: data:font/woff2;base64,AAAA",
        }),
      );
    });

    it("permits and collects an unquoted relative reference with a query string containing a semicolon", () => {
      const { referencedHrefs } = scanCss("body { background: url(a.png?x=1;y=2); }", cssContext);
      expect(referencedHrefs).toEqual(["OEBPS/styles/a.png?x=1;y=2"]);
    });
  });

  // Ruling CJ: `url()` is not the only way CSS names a URL. CSS Images 4 states that "Each
  // <string> inside image-set() represents a <url>", and real Chrome fetches it - yet
  // `image-set("https://evil/x.png" 1x)` contains no `url(` or `@import` substring anywhere, so
  // every previous version of this scanner, regex and tokenizer alike, accepted it silently.
  // CSS ships byte-for-byte, so that was a live route to an attacker-controlled fetch from
  // every reader's browser.
  describe("treats a bare string as a reference inside URL-bearing functions (Ruling CJ)", () => {
    // One realistic spelling per function, so every case is CSS someone could actually write.
    const urlBearingFunctions = [
      { name: "image-set", css: (target: string) => `body { background: image-set(${target} 1x); }` },
      { name: "-webkit-image-set", css: (target: string) => `body { background: -webkit-image-set(${target} 1x); }` },
      { name: "image", css: (target: string) => `body { background: image(${target}); }` },
      { name: "src", css: (target: string) => `@font-face { font-family: X; src: src(${target}); }` },
    ];

    for (const { name, css } of urlBearingFunctions) {
      it(`rejects an external URL passed to ${name}() as a bare string`, () => {
        expect(() => scanCss(css('"https://tracker.example/x.png"'), cssContext)).toThrow(
          expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
        );
      });

      it(`rejects a protocol-relative URL passed to ${name}() as a bare string`, () => {
        expect(() => scanCss(css('"//tracker.example/x.png"'), cssContext)).toThrow(
          expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
        );
      });

      it(`collects a relative reference passed to ${name}() as a bare string`, () => {
        expect(scanCss(css('"../images/hero.png"'), cssContext).referencedHrefs).toEqual(["OEBPS/images/hero.png"]);
      });
    }

    it("still reaches allowedDataUrlMediaTypes for a data: URL given as a bare string", () => {
      // The media-type policy must be what decides, exactly as it does for a url() target.
      expect(scanCss('body { background: image-set("data:image/png;base64,AAAA" 1x); }', cssContext).referencedHrefs).toEqual([]);
      expect(() => scanCss('body { background: image-set("data:application/octet-stream;base64,AAAA" 1x); }', cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("normalizes CSS escapes inside a bare string target, so an escaped scheme cannot smuggle one past", () => {
      // `\68` is hex for "h", so this decodes to https://... before it is ever classified.
      expect(() => scanCss('body { background: image-set("\\68 ttps://tracker.example/x.png" 1x); }', cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    // The exclusions carry as much weight as the inclusions: each of these takes a bare string
    // that is NOT a URL, and the first two sit directly beside url() inside @font-face, where a
    // careless "strings are references" rule would corrupt ordinary font stylesheets.
    it("does not treat local()'s font family name as a reference", () => {
      const css = '@font-face { font-family: X; src: local("Some Installed Font"); }';
      expect(() => scanCss(css, cssContext)).not.toThrow();
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    it("does not treat format()'s hint as a reference, and still collects the url() beside it", () => {
      const css = '@font-face { font-family: X; src: url(../fonts/body.woff2) format("woff2"); }';
      expect(scanCss(css, cssContext).referencedHrefs).toEqual(["OEBPS/fonts/body.woff2"]);
    });

    it("does not treat image-set()'s own type() MIME string as a reference", () => {
      // Innermost enclosing function wins. Per CSS Images 4 the string in type() is a MIME
      // type, so only the outer string is a URL - treating every string inside image-set() as
      // one would collect a bogus "OEBPS/styles/image/webp" reference.
      const css = 'body { background: image-set("a.png" type("image/webp")); }';
      expect(scanCss(css, cssContext).referencedHrefs).toEqual(["OEBPS/styles/a.png"]);
    });

    it("leaves a bare string alone outside any URL-bearing function", () => {
      // The rule is keyed on the enclosing function, never on strings in general, and
      // `content` is not one - so this stays inert rather than failing the publication.
      const css = 'body::after { content: "https://tracker.example/x.png"; }';
      expect(() => scanCss(css, cssContext)).not.toThrow();
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    it("keeps the url() spelling working alongside a bare string in the same function", () => {
      const css = 'body { background: image-set(url("../images/hero.png") 1x, "../images/hero@2x.png" 2x); }';
      expect(scanCss(css, cssContext).referencedHrefs).toEqual(["OEBPS/images/hero.png", "OEBPS/images/hero@2x.png"]);
    });
  });

  // Ruling CK: an at-rule *prelude* - everything between the at-keyword and its `{` or `;` - is
  // a condition, not a value. A browser evaluates a feature query without fetching anything, so
  // Ruling CJ's bare-string rule firing there both failed the whole publication and, for a
  // relative string, fed the Ruling AW sample closure a href nothing will ever request. Same
  // defect class as B1, one context over, and it arrived with CJ.
  //
  // `@import` is the trap: its prelude string genuinely IS a URL, and a naive suppression would
  // re-open the fail-open hole that cost three rounds earlier in this file's history. It
  // survives structurally rather than by exception - `scanCss` resolves an `@import` target in
  // the at-keyword branch and skips the token, so that string is never offered to the rule this
  // suppression guards. The three `@import` cases below are that regression guard.
  describe("does not read a reference out of an at-rule prelude (Ruling CK)", () => {
    it("does not reject an external bare string inside a @supports prelude", () => {
      const css = '@supports (background-image: image-set("https://tracker.example/x.png" 1x)) { body { color: red; } }';
      expect(() => scanCss(css, cssContext)).not.toThrow();
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    it("does not collect a relative bare string inside a @supports prelude", () => {
      // Nothing fetches this, so it must not enter the sample closure as a phantom resource.
      const css = '@supports (background-image: image-set("../images/hero.png" 1x)) { body { color: red; } }';
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    it("leaves a string in a @media prelude inert", () => {
      const css = '@media (min-width: 400px) and (foo: image-set("https://tracker.example/x.png" 1x)) { body { color: red; } }';
      expect(() => scanCss(css, cssContext)).not.toThrow();
      expect(scanCss(css, cssContext).referencedHrefs).toEqual([]);
    });

    // The over-correction guard: suppression covers the prelude only, never the at-rule's body.
    it("still scans the body of an at-rule whose prelude was suppressed", () => {
      const css = '@supports (display: grid) { body { background: image-set("https://tracker.example/x.png" 1x); } }';
      expect(() => scanCss(css, cssContext)).toThrow(expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }));
    });

    it("still collects a bare-string reference in a @font-face body", () => {
      // @font-face is an at-rule too: its `{` ends the prelude, so the body is scanned normally.
      const css = '@font-face { font-family: X; src: src("../fonts/body.woff2"); }';
      expect(scanCss(css, cssContext).referencedHrefs).toEqual(["OEBPS/fonts/body.woff2"]);
    });

    it("still collects a relative @import target", () => {
      expect(scanCss('@import "base.css";', cssContext).referencedHrefs).toEqual(["OEBPS/styles/base.css"]);
    });

    it("still rejects an external @import given as a bare string", () => {
      // The exact fail-open hole a naive prelude suppression would re-open.
      expect(() => scanCss('@import "https://tracker.example/x.css";', cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });

    it("still rejects an external @import given as url()", () => {
      expect(() => scanCss('@import url("https://tracker.example/x.css");', cssContext)).toThrow(
        expect.objectContaining({ code: "UNSAFE_EXTERNAL_URL" }),
      );
    });
  });
});
