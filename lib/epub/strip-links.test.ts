import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { processEpub } from "@/lib/epub/process";
import { stripExternalLinks } from "@/lib/epub/strip-links";
import { assembleEpub, chapterXhtml, epubWithExternalUrl, validEpubEntries } from "@/scripts/fixtures/create-test-epub";

describe("stripExternalLinks", () => {
  it("unwraps external anchors, keeps their text and internal links, and the result validates", async () => {
    const chapter1 = chapterXhtml(
      "Chapter 1",
      '<p><a href="https://example.com/x">Fanpage</a> · <a href=\'mailto:a@b.c\'>Mail</a> · <a href="chapter2.xhtml">Next</a></p>',
    );
    const original = assembleEpub(validEpubEntries({ chapter1 }));
    await expect(processEpub(original)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });

    const { bytes, unwrapped } = stripExternalLinks(original);

    expect(unwrapped).toEqual({ "OEBPS/text/chapter1.xhtml": 2 });
    expect(Object.keys(unzipSync(bytes))[0]).toBe("mimetype");
    const text = strFromU8(unzipSync(bytes)["OEBPS/text/chapter1.xhtml"]);
    expect(text).toContain("<p>Fanpage · Mail · <a href=\"chapter2.xhtml\">Next</a></p>");
    await expect(processEpub(bytes)).resolves.toBeDefined();
  });

  it("leaves an external image alone so validation still rejects it", async () => {
    const { bytes, unwrapped } = stripExternalLinks(epubWithExternalUrl());

    expect(unwrapped).toEqual({});
    await expect(processEpub(bytes)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
  });
});
