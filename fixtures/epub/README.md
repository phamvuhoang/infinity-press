# Private EPUB fixture corpus

This directory holds the metadata for the private Infinity Books EPUB
corpus used to develop and validate the ebook processor, the reader engine,
and the Readium feasibility spike. **The EPUB files themselves, and any
content extracted from a paid book, must never be committed to this repo.**
`.gitignore` enforces this for the two paths below; this README is what
keeps a human from accidentally overriding that.

## What is git-ignored, and what is not

| Path | Committed? |
| --- | --- |
| `fixtures/epub/README.md` (this file) | Yes |
| `fixtures/epub/manifest.example.json` | Yes - a shape template with no real book data |
| `fixtures/epub/manifest.local.json` | **No** - your real fixture list, git-ignored |
| `fixtures/epub/private/*.epub` | **No** - the actual EPUB files, git-ignored |

Never rename or move a real `.epub` file, or a copy of one, outside
`fixtures/epub/private/`. Never paste extracted chapter text, images, or
fonts from a paid book into a commit, a test fixture, a code comment, or a
bug report attached to this repo.

## Setting up your local corpus

1. Create the directory if it does not exist: `fixtures/epub/private/`.
2. Copy 5 or more private Infinity Books `.epub` files into it, e.g.
   `fixtures/epub/private/book-01.epub`.
3. Copy `manifest.example.json` to `manifest.local.json` and add one entry
   per file, following the shape in the example. `id` and `path` are
   required; `path` is relative to `fixtures/epub/` (so a file placed as
   above is `"private/book-01.epub"`). `language` is a BCP 47 tag.
4. Fill in `features` for each fixture from the vocabulary below. Every
   feature in the list must be covered by **at least one** fixture across
   the whole corpus - no single book needs to cover all of them.

## Required feature coverage

The corpus as a whole (not any single book) must exercise:

- `embedded-fonts` - the EPUB carries its own `@font-face` font files.
- `images` - raster or vector images in the reading order.
- `long-chapters` - at least one chapter long enough to stress virtualized/
  paginated rendering and locator stability (rough guideline: 5,000+ words
  or several screens of continuous reading).
- `internal-links` - in-book links between chapters or to footnotes/endnotes.
- `lists-tables` - ordered/unordered lists and at least one HTML table.
- `varied-css` - stylesheets beyond simple paragraph/heading rules: multi-
  column layout, drop caps, custom blockquote/pull-quote styling, or similar.

Pick books so that, across all 5+ fixtures, every feature above appears at
least once. A single book can and should carry multiple features - use the
`features` array to record all of them, not just the primary one.

## Example `manifest.local.json` shape

```json
{
  "fixtures": [
    { "id": "book-01", "path": "private/book-01.epub", "language": "vi", "features": ["embedded-fonts", "images", "long-chapters"] },
    { "id": "book-02", "path": "private/book-02.epub", "language": "vi", "features": ["internal-links", "images"] },
    { "id": "book-03", "path": "private/book-03.epub", "language": "en", "features": ["lists-tables", "varied-css"] },
    { "id": "book-04", "path": "private/book-04.epub", "language": "vi", "features": ["varied-css", "long-chapters"] },
    { "id": "book-05", "path": "private/book-05.epub", "language": "vi", "features": ["embedded-fonts", "internal-links", "lists-tables"] }
  ]
}
```

## Who uses this

- Later processor and worker tasks generate their own synthetic test EPUBs
  at runtime (see `scripts/fixtures/create-test-epub.ts`) and do not read
  this corpus - the private corpus is not needed to run `npm test`.
- The Readium feasibility spike (Task 9) is validated by hand against every
  fixture in your local manifest, across desktop/mobile Chrome, Safari, and
  Firefox. Keep `manifest.local.json` accurate so that matrix has a
  complete, current list to work from.
- CI and the automated golden-path E2E test never touch this corpus; they
  use a single generated, public-domain fixture instead.
