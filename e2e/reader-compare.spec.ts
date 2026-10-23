import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { addPublishedEdition, soleEditionId } from "./support/editions";
import { grantEntitlement, seedProcessedBook } from "./support/publication";
import { createServiceRoleClient } from "./support/supabase";

// S20 compare. A work with a processed English edition (the fixture EPUB is English, and publishing
// refuses a language mismatch) and a Vietnamese one whose search chunks mirror it resource by
// resource. `ebook align` pairs them with no manual step; a reader who owns both opens the English
// edition with the Vietnamese interface and sees the Vietnamese passage.
test("a reader who owns two aligned editions compares the passage they are reading", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { bookId, publicationId } = await seedProcessedBook({
    suffix,
    localizations: {
      en: { slug: `compare-${suffix}`, title: `Compare ${suffix}` },
      vi: { slug: `doi-chieu-${suffix}`, title: `Đối chiếu ${suffix}` },
    },
  });
  const reader = await createReader("compare");
  await grantEntitlement(bookId, reader.email);
  const englishEditionId = await soleEditionId(bookId);
  const vietnamese = await addPublishedEdition(bookId, "vi", suffix, []);

  // The Vietnamese publication has no EPUB of its own; its chunks are the English ones, marked.
  const service = createServiceRoleClient();
  const chunks = await service
    .from("ebook_search_chunks")
    .select("href, chapter_title, ordinal, plain_text, locator_json")
    .eq("publication_id", publicationId)
    .order("ordinal");
  if (chunks.error) throw chunks.error;
  expect(chunks.data.length).toBeGreaterThan(0);
  const inserted = await service.from("ebook_search_chunks").insert(
    chunks.data.map((chunk) => ({ ...chunk, publication_id: vietnamese.publicationId, plain_text: `VI ${chunk.plain_text}`.slice(0, 1024) })),
  );
  if (inserted.error) throw inserted.error;

  const granted = await service.from("entitlements").insert({
    profile_id: reader.profileId,
    book_id: bookId,
    edition_id: vietnamese.editionId,
    source_type: "admin_grant",
    actor_profile_id: reader.profileId,
    reason: "E2E compare",
    status: "active",
  });
  if (granted.error) throw granted.error;

  const output = execFileSync("npx", ["tsx", "scripts/ebook.ts", "align", bookId], { encoding: "utf8", env: process.env });
  expect(JSON.parse(output).runs).toEqual([
    expect.objectContaining({ coverage: 1 }),
    expect.objectContaining({ coverage: 1 }),
  ]);

  await signInAs(page, reader.email, `/vi/read/editions/${englishEditionId}`);
  await page.goto(`/vi/read/editions/${englishEditionId}`);
  await expect(page.getByRole("button", { name: "Trang sau" })).toBeEnabled({ timeout: 30_000 });

  await page.getByRole("button", { name: "Đối chiếu" }).click();
  const panel = page.getByRole("dialog", { name: "Đối chiếu" });
  const passage = panel.locator('blockquote[lang="vi"]');
  await expect(passage).toBeVisible();
  await expect(passage).toContainText("VI ");
  await expect(panel.getByRole("link", { name: "Mở trong ấn bản đó" })).toHaveAttribute(
    "href",
    new RegExp(`/vi/read/editions/${vietnamese.editionId}\\?anchor=\\d+$`),
  );
});
