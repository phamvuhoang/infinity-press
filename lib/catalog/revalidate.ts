import { revalidatePath } from "next/cache";

// Every public storefront page lives under /[lang] (the route segment folder - see
// app/[lang]/layout.tsx for why it isn't named [locale]). Revalidating that layout refreshes the
// home, catalog, book, entity, and search pages together. The sitemap lists the same books and
// entities, and /llms.txt indexes them too.
export function revalidateStorefront() {
  revalidatePath("/[lang]", "layout");
  revalidatePath("/sitemap.xml");
  revalidatePath("/llms.txt");
}

// Every page that shows a book's catalog data.
export function revalidateBookAdmin(bookId: string) {
  revalidatePath("/admin/books");
  revalidatePath(`/admin/books/${bookId}`);
  revalidateStorefront();
}

// Every page that shows a bundle's catalog data. The storefront bundle pages arrive with the
// public bundle surface; revalidating the locale layout already covers them.
export function revalidateBundleAdmin(bundleId: string) {
  revalidatePath("/admin/bundles");
  revalidatePath(`/admin/bundles/${bundleId}`);
  revalidateStorefront();
}

// S12: ideas and articles appear on their own pages, on each other's pages, on book and topic
// backlinks, in search, and in the sitemap - all under the locale layout. Both admin lists are
// refreshed because the idea list feeds the article editor's idea options, and one helper keeps
// every knowledge mutation on the same complete set.
export function revalidateKnowledgeHub(kind: "idea" | "article", id: string) {
  revalidateStorefront();
  revalidatePath("/admin/ideas");
  revalidatePath("/admin/articles");
  revalidatePath(`/admin/${kind === "idea" ? "ideas" : "articles"}/${id}`);
}
