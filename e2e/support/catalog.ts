import { soleEditionId } from "./editions";
import { createServiceRoleClient } from "./supabase";

// Seeds a complete catalog book for public-page tests. Service role only; local stack only.
// S1's admin-catalog spec covers the operator path that produces the same rows.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

type Locale = "vi" | "en";

// Throws on a failed write. Inserts without `.select()` return null data, which callers ignore.
function check<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as NonNullable<T>;
}

// This writes through the service-role client directly, bypassing every admin Server Action - the
// only thing that normally calls revalidateStorefront() when the catalog changes. The home page and
// the catalog list are prerendered, so a spec that seeds here and then asserts against either of
// them has to trigger revalidation itself before navigating - see e2e/support/revalidate.ts. A
// detail page for a brand-new slug needs no such call: it renders on demand.
export async function seedCatalogBook(options: {
  suffix: string;
  localizations: Partial<Record<Locale, { slug: string; title: string }>>;
  priceMinor?: number;
  status?: "published" | "draft";
  withSample?: boolean;
  // Task 6 (storefront static caching): seeds the prose fields the book page renders below the
  // fold - audience, key ideas, FAQ - so a raw-HTML crawler assertion has something locale-specific
  // to find. Off by default: most callers only need the identity fields above.
  withSubstance?: boolean;
}): Promise<{ bookId: string; topicSlug: string; authorId: string; topicId: string; topicName: string }> {
  const service = createServiceRoleClient();
  const { suffix, localizations } = options;
  const locales = Object.keys(localizations) as Locale[];

  const author = check(
    await service
      .from("authors")
      .insert({ canonical_slug: `e2e-author-${suffix}`, display_name: `E2E Author ${suffix}`, status: "published" })
      .select("id")
      .single(),
  );
  check(
    await service.from("author_localizations").insert(
      locales.map((locale) => ({
        author_id: author.id,
        locale,
        slug: `e2e-author-${locale}-${suffix}`,
        name: `E2E Author ${suffix}`,
      })),
    ),
  );

  const book = check(
    await service
      .from("books")
      .insert({ canonical_key: `e2e-book-${suffix}`, original_language: locales[0], primary_author_id: author.id })
      .select("id")
      .single(),
  );
  check(
    await service.from("book_localizations").insert(
      locales.map((locale) => ({
        book_id: book.id,
        locale,
        slug: localizations[locale]!.slug,
        title: localizations[locale]!.title,
        short_description: `Short copy ${suffix}`,
        description: `Long copy ${suffix}`,
        ...(options.withSubstance
          ? {
              audience: `Audience copy ${locale} ${suffix}`,
              key_ideas: [{ title: `Key idea ${locale} ${suffix}`, summary: `Key idea summary ${locale} ${suffix}` }],
              faq: [{ question: `FAQ question ${locale} ${suffix}`, answer: `FAQ answer ${locale} ${suffix}` }],
            }
          : {}),
      })),
    ),
  );

  const edition = check(
    await service.from("editions").insert({ book_id: book.id, language_code: locales[0] }).select("id").single(),
  );
  const sku = check(
    await service.from("skus").insert({ edition_id: edition.id, sku_code: `e2e-sku-${suffix}` }).select("id").single(),
  );
  check(await service.from("offers").insert({ sku_id: sku.id, market_code: "VN", currency: "VND", price_minor: options.priceMinor ?? 0 }));

  const asset = check(
    await service
      .from("ebook_assets")
      .insert({ edition_id: edition.id, source_storage_key: `e2e/${suffix}/source.epub`, version: 1, status: "published" })
      .select("id")
      .single(),
  );
  const publication = check(
    await service
      .from("ebook_publications")
      .insert({ ebook_asset_id: asset.id, version: 1, manifest_key: `e2e/${suffix}/manifest.json`, status: "published" })
      .select("id")
      .single(),
  );
  if (options.withSample) {
    check(await service.from("book_samples").insert({ publication_id: publication.id, allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] }));
  }

  const coverKey = `books/${book.id}/${crypto.randomUUID()}.png`;
  check(await service.storage.from("covers").upload(coverKey, PNG, { contentType: "image/png" }));
  check(
    await service
      .from("media_assets")
      .insert({ owner_type: "book", owner_id: book.id, kind: "cover", storage_key: coverKey, alt_text: `Cover ${suffix}` }),
  );

  const topicName = `E2E Topic ${suffix}`;
  const topic = check(
    await service
      .from("topics")
      .insert({ canonical_slug: `e2e-topic-${suffix}`, name: topicName, status: "published" })
      .select("id")
      .single(),
  );
  const topicSlug = `e2e-topic-${locales[0]}-${suffix}`;
  check(
    await service.from("topic_localizations").insert(
      locales.map((locale) => ({ topic_id: topic.id, locale, slug: `e2e-topic-${locale}-${suffix}`, name: topicName })),
    ),
  );
  check(await service.from("book_topics").insert({ book_id: book.id, topic_id: topic.id }));

  if (options.withSubstance) {
    const series = check(
      await service
        .from("series")
        .insert({ canonical_slug: `e2e-series-${suffix}`, display_name: `E2E Series ${suffix}`, status: "published" })
        .select("id")
        .single(),
    );
    check(
      await service.from("series_localizations").insert(
        locales.map((locale) => ({ series_id: series.id, locale, slug: `e2e-series-${locale}-${suffix}`, name: `E2E Series ${suffix}` })),
      ),
    );
    check(await service.from("book_series").insert({ book_id: book.id, series_id: series.id, position: 1 }));
  }

  check(
    await service
      .from("books")
      .update({ active_publication_id: publication.id, status: options.status ?? "published" })
      .eq("id", book.id),
  );

  // authorId and topicId are the two handles a recommendation fixture needs: the signals
  // recommend_books scores are shared author and shared topic, and each seeded book otherwise
  // gets an author and a topic of its own. Existing callers ignore them. topicName (S12) is the label
  // the admin knowledge editor shows beside the topic's relation checkbox.
  return { bookId: book.id as string, topicSlug, authorId: author.id as string, topicId: topic.id as string, topicName };
}

// Makes `candidateBookId` share `authorId` as its primary author, which is the shared-author
// signal recommend_books scores. Service role only, and createServiceRoleClient refuses any
// non-loopback Supabase URL, so this cannot reach the cloud project. Like every other fixture
// here it writes without teardown; the books it edits were created by this same module.
export async function sharePrimaryAuthor(authorId: string, candidateBookId: string): Promise<void> {
  const service = createServiceRoleClient();
  check(await service.from("books").update({ primary_author_id: authorId }).eq("id", candidateBookId));
}

// Same caveat as seedCatalogBook: a direct write, not an admin action, so it does not refresh the
// prerendered home page by itself - see e2e/support/revalidate.ts.
export async function setHomeFeatured(bookId: string): Promise<void> {
  const service = createServiceRoleClient();
  check(await service.from("merchandising_slots").delete().eq("slot_key", "home_featured"));
  check(await service.from("merchandising_slots").insert({ slot_key: "home_featured", book_id: bookId, position: 1 }));
}

// A published bundle over books that seedCatalogBook already created (S9 spec 6). Service role
// only, local stack only, exactly like seedCatalogBook above.
//
// This deliberately does NOT drive the admin bundle screens. `docs/runbooks/bundles-and-gifts.md`
// is the operator path and admin-catalog specs cover the admin surface; a journey about buying a
// bundle needs the artefact, not the eleven clicks that build one. The three bundle tables carry a
// service_role write grant precisely so a fixture can do this (20260924110000).
export async function seedBundle(options: {
  suffix: string;
  bookIds: string[];
  // Name the editions directly for a bundle that holds several editions of one work.
  editionIds?: string[];
  localizations: Partial<Record<Locale, { slug: string; title: string }>>;
  // create_bundle_order refuses an offer of 0, so a bundle fixture is always priced.
  priceMinor: number;
  status?: "published" | "draft";
}): Promise<{ bundleId: string; title: string }> {
  const service = createServiceRoleClient();
  const { suffix, bookIds, localizations } = options;
  const locales = Object.keys(localizations) as Locale[];

  const bundle = check(await service.from("bundles").insert({ status: "draft" }).select("id").single());
  check(
    await service.from("bundle_localizations").insert(
      locales.map((locale) => ({
        bundle_id: bundle.id,
        locale,
        slug: localizations[locale]!.slug,
        title: localizations[locale]!.title,
        subtitle: `Two books, one price ${suffix}`,
        description: `Bundle copy ${suffix}`,
      })),
    ),
  );
  // A bundle holds editions. Each seeded book has exactly one, so members are named by book here and
  // resolved to that edition; position is 1-based and unique per bundle, and the order here is the
  // order the storefront, the checkout list and the order items all use.
  const editionIds = options.editionIds ?? (await Promise.all(bookIds.map(soleEditionId)));
  check(
    await service
      .from("bundle_editions")
      .insert(editionIds.map((editionId, index) => ({ bundle_id: bundle.id, edition_id: editionId, position: index + 1 }))),
  );
  check(
    await service
      .from("offers")
      .insert({ bundle_id: bundle.id, market_code: "VN", currency: "VND", price_minor: options.priceMinor }),
  );

  const coverKey = `bundles/${bundle.id}/${crypto.randomUUID()}.png`;
  check(await service.storage.from("covers").upload(coverKey, PNG, { contentType: "image/png" }));
  check(
    await service
      .from("media_assets")
      .insert({ owner_type: "bundle", owner_id: bundle.id, kind: "cover", storage_key: coverKey, alt_text: `Cover ${suffix}` }),
  );

  // Published last, so no reader can ever see a bundle that has no members, no price and no cover.
  check(await service.from("bundles").update({ status: options.status ?? "published" }).eq("id", bundle.id));

  return { bundleId: bundle.id as string, title: localizations[locales[0]]!.title };
}
