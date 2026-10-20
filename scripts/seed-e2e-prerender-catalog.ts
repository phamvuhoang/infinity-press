#!/usr/bin/env -S npx tsx
// Seeds one representative catalog book - with an author, a series, and a topic, in both locales -
// so the CI e2e job's production build has real content by the time
// `npm run check:prerender -- --require-content` asks for a concrete /[lang]/books/[slug] page.
//
// The e2e job's Supabase stack starts genuinely empty (supabase/config.toml disables seeding on
// purpose - see its comment), and Playwright's `webServer` runs `npm run build && npm run start`
// the moment `npm run test:e2e` starts, before any spec has created anything. Without this step,
// the manifest that build writes was built against zero books, and the content check would fail
// every clean CI run - not because prerendering broke, but because there was nothing to prerender.
//
// Reuses e2e/support/catalog.ts's fixture, which already refuses to run against anything but a
// loopback Supabase URL. Run this BEFORE `npm run test:e2e` (and so before its build), with the
// same NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the e2e job already exports.
import { seedCatalogBook } from "@/e2e/support/catalog";

async function main() {
  const { bookId } = await seedCatalogBook({
    suffix: "ci-prerender-seed",
    localizations: {
      vi: { slug: "ci-seed-sach", title: "CI Seed Sách" },
      en: { slug: "ci-seed-book", title: "CI Seed Book" },
    },
    priceMinor: 100000,
    status: "published",
    withSubstance: true,
  });
  console.log(`Seeded catalog book ${bookId} (author, series, topic, both locales) for the CI prerender content check.`);
}

void main();
