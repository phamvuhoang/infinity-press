import { strFromU8, strToU8, zipSync, type Zippable } from "fflate";

import { openEpubArchive } from "@/lib/epub/archive";

// Operator pre-upload fix for `UNSAFE_EXTERNAL_URL` from outbound links (Standard Ebooks
// colophons, publisher community pages). Unwraps `<a href="http(s)|mailto:...">` to its text
// and leaves everything else untouched. It does not change the sanitizer: the output still has
// to pass `validate`, so an external `<img src>` or CSS `url()` still fails there.
const EXTERNAL_ANCHOR = /<a\b[^>]*\bhref\s*=\s*["'](?:https?|mailto):[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;

export function stripExternalLinks(bytes: Uint8Array): { bytes: Uint8Array; unwrapped: Record<string, number> } {
  const archive = openEpubArchive(bytes);
  const unwrapped: Record<string, number> = {};
  // EPUB requires `mimetype` first and stored; fflate keeps insertion order.
  const zippable: Zippable = { mimetype: [archive.entries.get("mimetype")!, { level: 0 }] };

  for (const [path, data] of archive.entries) {
    if (path === "mimetype") continue;
    if (!/\.x?html?$/i.test(path)) {
      zippable[path] = data;
      continue;
    }
    let count = 0;
    const text = strFromU8(data).replace(EXTERNAL_ANCHOR, (_match, inner: string) => {
      count += 1;
      return inner;
    });
    if (count > 0) unwrapped[path] = count;
    zippable[path] = strToU8(text);
  }

  return { bytes: zipSync(zippable), unwrapped };
}
