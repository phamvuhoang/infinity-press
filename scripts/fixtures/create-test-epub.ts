// Runtime EPUB fixture generation for lib/epub's test suite. Nothing here is committed as
// a binary: every test builds the bytes it needs at runtime via `fflate.zipSync()`, per the
// brief - a repo-ignored `*.epub` backstop exists, but the actual guarantee is that these
// functions are the only source of `.epub` bytes the test suite ever sees.
import { strToU8, zipSync, type Zippable, type ZipOptions } from "fflate";

import { EPUB_MIME_TYPE } from "@/lib/epub/constants";

export type FixtureEntry = {
  // Raw ZIP entry name, exactly as it should appear in the archive - test fixtures that
  // exercise path-safety rejections pass a deliberately unsafe name here.
  path: string;
  content: string | Uint8Array;
  // `true` stores the entry without compression (required for `mimetype`, per OCF 3.3).
  // Omitted/false lets fflate deflate it, which is what test fixtures use to build a
  // genuinely high compression-ratio entry (e.g. a large run of zero bytes).
  store?: boolean;
};

// Assembles a ZIP archive from exactly the entries given, in order, with no validation of
// its own - callers that want an EPUB fixture with one thing deliberately wrong build the
// full entry list (typically starting from `validEpubEntries()`) and mutate it before
// calling this. Entry order matters: EPUB requires `mimetype` first, and `Zippable`'s plain
// object preserves insertion order for the non-numeric string keys used here.
export function assembleEpub(entries: FixtureEntry[]): Uint8Array {
  const zippable: Zippable = {};
  for (const entry of entries) {
    const data = typeof entry.content === "string" ? strToU8(entry.content) : entry.content;
    const options: ZipOptions = entry.store ? { level: 0 } : {};
    zippable[entry.path] = [data, options];
  }
  return zipSync(zippable);
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const CONTAINER_XML_TWO_ROOTFILES = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    <rootfile full-path="OEBPS/content2.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

function opfDocument(options: { spine?: string; titleElement?: string; doctype?: string } = {}): string {
  const doctype = options.doctype ?? "";
  const titleElement = options.titleElement ?? "<dc:title>Test Publication</dc:title>";
  const spine = options.spine ?? '<itemref idref="chapter1"/>\n    <itemref idref="chapter2"/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
${doctype}
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-123456789012</dc:identifier>
    ${titleElement}
    <dc:language>en</dc:language>
    <dc:creator>Jane Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="styles/style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>
`;
}

const NAV_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
<nav epub:type="toc">
<ol>
<li><a href="text/chapter1.xhtml">Chapter 1</a></li>
<li><a href="text/chapter2.xhtml">Chapter 2</a></li>
</ol>
</nav>
</body>
</html>
`;

function chapterXhtml(heading: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${heading}</title><link rel="stylesheet" href="../styles/style.css" type="text/css"/></head>
<body>
<h1>${heading}</h1>
${body}
</body>
</html>
`;
}

const VALID_CHAPTER1 = chapterXhtml("Chapter 1", '<p>Hello <em>world</em>.</p>\n<img src="../images/cover.jpg" alt="Cover"/>');
const VALID_CHAPTER2 = chapterXhtml("Chapter 2", "<p>The second chapter.</p>\n<ul>\n<li>One</li>\n<li>Two</li>\n</ul>");

const STYLE_CSS = "body { font-family: serif; }\n";

// Not a decodable JPEG - processing never decodes image bytes, only hashes and stores
// them, so a short byte string with a plausible-looking magic number is enough.
const COVER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

export function validEpubEntries(overrides: { chapter1?: string; opf?: string; container?: string; nav?: string } = {}): FixtureEntry[] {
  return [
    { path: "mimetype", content: EPUB_MIME_TYPE, store: true },
    { path: "META-INF/container.xml", content: overrides.container ?? CONTAINER_XML },
    { path: "OEBPS/content.opf", content: overrides.opf ?? opfDocument() },
    { path: "OEBPS/nav.xhtml", content: overrides.nav ?? NAV_XHTML },
    { path: "OEBPS/text/chapter1.xhtml", content: overrides.chapter1 ?? VALID_CHAPTER1 },
    { path: "OEBPS/text/chapter2.xhtml", content: VALID_CHAPTER2 },
    { path: "OEBPS/styles/style.css", content: STYLE_CSS },
    { path: "OEBPS/images/cover.jpg", content: COVER_JPEG },
  ];
}

export function validEpub(): Uint8Array {
  return assembleEpub(validEpubEntries());
}

// The EPUB3 nav document's TOC links carry a fragment ("#top" / "#sec1"), the norm for
// real publications - proves the TOC resolves the target document rather than a path
// that matches no resource.
export function validEpubWithTocFragments(): Uint8Array {
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
<nav epub:type="toc">
<ol>
<li><a href="text/chapter1.xhtml#top">Chapter 1</a></li>
<li><a href="text/chapter2.xhtml#sec1">Chapter 2</a></li>
</ol>
</nav>
</body>
</html>
`;
  return assembleEpub(validEpubEntries({ nav }));
}

// Missing META-INF/container.xml entirely - archive.ts must reject before parsing ever runs.
export function epubMissingContainer(): Uint8Array {
  return assembleEpub(validEpubEntries().filter((entry) => entry.path !== "META-INF/container.xml"));
}

// chapter1's stylesheet declares @font-face - EPUB's only real mechanism for referencing
// a font - so the Ruling AW sample closure can be proven to reach it via the CSS scan
// (Issue 3), the same way it already reaches an XHTML chapter's own <img>/<link> targets.
export function validEpubWithFont(): Uint8Array {
  const styleCss = "@font-face { font-family: 'Body'; src: url(../fonts/body.woff2); }\nbody { font-family: 'Body', serif; }\n";
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-123456789012</dc:identifier>
    <dc:title>Test Publication</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Jane Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="styles/style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="font" href="fonts/body.woff2" media-type="font/woff2"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
`;
  // Not a decodable font - processing never decodes font bytes, only hashes/stores them.
  const fontBytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x00, 0x00, 0x00]);
  return assembleEpub([
    { path: "mimetype", content: EPUB_MIME_TYPE, store: true },
    { path: "META-INF/container.xml", content: CONTAINER_XML },
    { path: "OEBPS/content.opf", content: opf },
    { path: "OEBPS/nav.xhtml", content: NAV_XHTML },
    { path: "OEBPS/text/chapter1.xhtml", content: VALID_CHAPTER1 },
    { path: "OEBPS/text/chapter2.xhtml", content: VALID_CHAPTER2 },
    { path: "OEBPS/styles/style.css", content: styleCss },
    { path: "OEBPS/images/cover.jpg", content: COVER_JPEG },
    { path: "OEBPS/fonts/body.woff2", content: fontBytes },
  ]);
}

// The stylesheet references a remote tracking pixel via url() - Ruling AZ requires this
// be rejected the same way an unsafe XHTML reference is, not stored byte-for-byte.
export function epubWithUnsafeCss(): Uint8Array {
  const styleCss = "body { background: url(https://tracker.example/pixel.png); }\n";
  return assembleEpub(validEpubEntries().map((entry) => (entry.path === "OEBPS/styles/style.css" ? { ...entry, content: styleCss } : entry)));
}

// container.xml names two root package documents - parse.ts requires exactly one.
export function epubWithMultipleRootfiles(): Uint8Array {
  return assembleEpub(validEpubEntries({ container: CONTAINER_XML_TWO_ROOTFILES }));
}

// A spine with no itemref entries - not a "readable spine".
export function epubWithEmptySpine(): Uint8Array {
  return assembleEpub(validEpubEntries({ opf: opfDocument({ spine: "" }) }));
}

// chapter1.xhtml contains a <script> tag and an inline event handler, but no external
// reference - processing must succeed, with both stripped from the sanitized output.
export function epubWithUnsafeScript(): Uint8Array {
  const chapter1 = chapterXhtml(
    "Chapter 1",
    '<script>alert("pwned")</script>\n<p onclick="alert(1)">Click me</p>\n<p>Safe text.</p>',
  );
  return assembleEpub(validEpubEntries({ chapter1 }));
}

// chapter1.xhtml references a remote https:// image - processing must reject the whole
// publication rather than silently drop the attribute.
export function epubWithExternalUrl(): Uint8Array {
  const chapter1 = chapterXhtml("Chapter 1", '<p>Safe text.</p>\n<img src="https://example.com/evil.png" alt="Evil"/>');
  return assembleEpub(validEpubEntries({ chapter1 }));
}

// chapter1.xhtml references a protocol-relative image URL.
export function epubWithProtocolRelativeUrl(): Uint8Array {
  const chapter1 = chapterXhtml("Chapter 1", '<p>Safe text.</p>\n<img src="//example.com/evil.png" alt="Evil"/>');
  return assembleEpub(validEpubEntries({ chapter1 }));
}

// chapter1.xhtml uses a javascript: URL as a link target.
export function epubWithJavascriptUrl(): Uint8Array {
  const chapter1 = chapterXhtml("Chapter 1", '<p><a href="javascript:alert(1)">Click</a></p>');
  return assembleEpub(validEpubEntries({ chapter1 }));
}

// chapter1.xhtml embeds a data: URL whose media type is not allowlisted.
export function epubWithDisallowedDataUrl(): Uint8Array {
  const chapter1 = chapterXhtml(
    "Chapter 1",
    '<p><img src="data:application/octet-stream;base64,AAAA" alt="Bad"/></p>',
  );
  return assembleEpub(validEpubEntries({ chapter1 }));
}

// chapter1.xhtml links to chapter2.xhtml via an ordinary in-publication anchor, in
// addition to its usual stylesheet/cover-image references - used to prove the sample-set
// closure (Ruling AW) follows asset references but never a navigation link to another
// content document.
export function epubWithChapter1LinkingToChapter2(): Uint8Array {
  const chapter1 = chapterXhtml(
    "Chapter 1",
    '<p>Hello <em>world</em>.</p>\n<img src="../images/cover.jpg" alt="Cover"/>\n<p><a href="chapter2.xhtml">Next chapter</a></p>',
  );
  return assembleEpub(validEpubEntries({ chapter1 }));
}

// An archive entry whose raw name escapes the archive root via a `..` segment.
export function epubWithPathTraversal(): Uint8Array {
  return assembleEpub([...validEpubEntries(), { path: "../evil.txt", content: "escaped" }]);
}

// An archive entry with an absolute path.
export function epubWithAbsolutePath(): Uint8Array {
  return assembleEpub([...validEpubEntries(), { path: "/etc/evil.txt", content: "escaped" }]);
}

// Two distinct raw ZIP entry names that decode/normalize to the same in-archive path
// ("c" written literally vs. percent-encoded) - the "same class" of problem as `..` vs.
// `%2e%2e`, proven against a real duplicate rather than only against traversal.
export function epubWithDuplicateNormalizedPath(): Uint8Array {
  return assembleEpub([
    ...validEpubEntries(),
    { path: "OEBPS/text/%63hapter1.xhtml", content: "duplicate of chapter1.xhtml" },
  ]);
}

// More than the maximum permitted number of archive entries.
export function epubWithTooManyEntries(maxEntries: number): Uint8Array {
  const entries = validEpubEntries();
  for (let i = 0; entries.length <= maxEntries; i += 1) {
    entries.push({ path: `OEBPS/extra/${i}.txt`, content: "x" });
  }
  return assembleEpub(entries);
}

// One archive entry whose declared uncompressed size alone exceeds the total budget. Built
// from real (highly compressible) zero-filled bytes rather than a forged header, so the
// zip file itself stays small even though its declared uncompressed size does not.
export function epubWithOversizedTotal(totalBudgetBytes: number): Uint8Array {
  const oversized = new Uint8Array(totalBudgetBytes + 1024 * 1024);
  return assembleEpub([...validEpubEntries(), { path: "OEBPS/huge.bin", content: oversized }]);
}

// One archive entry whose compression ratio alone exceeds the maximum, while its declared
// uncompressed size stays comfortably within the total budget.
export function epubWithExtremeCompressionRatio(uncompressedBytes: number): Uint8Array {
  const compressible = new Uint8Array(uncompressedBytes);
  return assembleEpub([...validEpubEntries(), { path: "OEBPS/bomb.bin", content: compressible }]);
}

// content.opf declares a DOCTYPE with a custom internal entity and references it from
// <dc:title> - proves entity expansion is disabled rather than merely configured off.
export function epubWithEntityExpansion(): Uint8Array {
  const opf = opfDocument({
    doctype: '<!DOCTYPE package [ <!ENTITY injected "EXPANDED-BY-PARSER"> ]>',
    titleElement: "<dc:title>&injected;</dc:title>",
  });
  return assembleEpub(validEpubEntries({ opf }));
}

// A bilingual publication with repeated <dc:title> and <dc:language> (both legal in OPF);
// the parser reads repeats as an array, and the first one is the primary value.
export function epubWithRepeatedTitleAndLanguage(): Uint8Array {
  const opf = opfDocument({
    titleElement: "<dc:title>Primary Title</dc:title>\n    <dc:title>Subtitle</dc:title>\n    <dc:language>vi</dc:language>",
  });
  return assembleEpub(validEpubEntries({ opf }));
}

// An EPUB2-style publication with no EPUB3 nav document, navigated via an NCX instead -
// exercises parse.ts's NCX fallback path for the table of contents.
export function validEpubWithNcx(): Uint8Array {
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1"><navLabel><text>Chapter 1</text></navLabel><content src="text/chapter1.xhtml"/></navPoint>
    <navPoint id="np2"><navLabel><text>Chapter 2</text></navLabel><content src="text/chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-123456789012</dc:identifier>
    <dc:title>Test Publication</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>Jane Author</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="styles/style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
`;
  return assembleEpub([
    { path: "mimetype", content: EPUB_MIME_TYPE, store: true },
    { path: "META-INF/container.xml", content: CONTAINER_XML },
    { path: "OEBPS/content.opf", content: opf },
    { path: "OEBPS/toc.ncx", content: ncx },
    { path: "OEBPS/text/chapter1.xhtml", content: VALID_CHAPTER1 },
    { path: "OEBPS/text/chapter2.xhtml", content: VALID_CHAPTER2 },
    { path: "OEBPS/styles/style.css", content: STYLE_CSS },
    { path: "OEBPS/images/cover.jpg", content: COVER_JPEG },
  ]);
}

// ---- Japanese corpus (Press Task 9) -----------------------------------------------------------
// Generated, never committed. The text is public-domain wording written for the test: kanji, hiragana,
// katakana, ruby with fallback parentheses, Japanese punctuation, a long unbroken paragraph with no
// spaces (the shape that breaks word-based search), and a Japanese table of contents.
export const JAPANESE_CORPUS = {
  title: "星空の手紙",
  chapter1Heading: "第一章　星空",
  chapter2Heading: "第二章　手紙",
  rubyBase: "星空",
  rubyReading: "ほしぞら",
  searchFragment: "ほしぞら",
  quote: "遠い町の灯りが、静かに瞬いていた。",
  // 40 sentences with no spaces: one paragraph long enough to span several pages.
  longParagraph: Array.from({ length: 40 }, (_, index) => `第${index + 1}の夜、少女は窓の外の星を数えながら、返事のない手紙を書き続けた。`).join(""),
};

function japaneseOpf(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-1234567890ab</dc:identifier>
    <dc:title>${JAPANESE_CORPUS.title}</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>試験 太郎</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="styles/style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
`;
}

const JAPANESE_NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body>
<nav epub:type="toc">
<ol>
<li><a href="text/chapter1.xhtml">${JAPANESE_CORPUS.chapter1Heading}</a></li>
<li><a href="text/chapter2.xhtml">${JAPANESE_CORPUS.chapter2Heading}</a></li>
</ol>
</nav>
</body>
</html>
`;

function japaneseChapter(heading: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head><title>${heading}</title><link rel="stylesheet" href="../styles/style.css" type="text/css"/></head>
<body>
<h1>${heading}</h1>
${body}
</body>
</html>
`;
}

export function japaneseEpub(): Uint8Array {
  const chapter1 = japaneseChapter(
    JAPANESE_CORPUS.chapter1Heading,
    `<p><ruby>${JAPANESE_CORPUS.rubyBase}<rp>（</rp><rt>${JAPANESE_CORPUS.rubyReading}</rt><rp>）</rp></ruby>の下で、${JAPANESE_CORPUS.quote}</p>\n<p>${JAPANESE_CORPUS.longParagraph}</p>`,
  );
  const chapter2 = japaneseChapter(JAPANESE_CORPUS.chapter2Heading, "<p>「ありがとう」と彼女は言った。『本当に？』――そして、静かに笑った。</p>");
  return assembleEpub([
    { path: "mimetype", content: EPUB_MIME_TYPE, store: true },
    { path: "META-INF/container.xml", content: CONTAINER_XML },
    { path: "OEBPS/content.opf", content: japaneseOpf() },
    { path: "OEBPS/nav.xhtml", content: JAPANESE_NAV },
    { path: "OEBPS/text/chapter1.xhtml", content: chapter1 },
    { path: "OEBPS/text/chapter2.xhtml", content: chapter2 },
    { path: "OEBPS/styles/style.css", content: "body { font-family: serif; line-height: 1.8; }\nrt { font-size: 0.5em; }\n" },
    { path: "OEBPS/images/cover.jpg", content: COVER_JPEG },
  ]);
}

// A stylesheet that sets vertical writing, which Press does not support at launch (horizontal only).
// `css` overrides the sheet, so a test can hide the declaration the ways real sheets do.
export function epubWithVerticalWriting(css = "html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }\n"): Uint8Array {
  return assembleEpub(
    validEpubEntries().map((entry) => (entry.path === "OEBPS/styles/style.css" ? { ...entry, content: css } : entry)),
  );
}
