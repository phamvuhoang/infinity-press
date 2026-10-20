import { saveMerchandisingAction } from "@/app/admin/merchandising/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { HeroBackgroundForm } from "@/components/admin/hero-background-form";
import { FeaturedBookForm, ShelfForm } from "@/components/admin/merchandising-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { getHomeHeroForAdmin } from "@/lib/data/home-hero";
import { getMerchandising } from "@/lib/data/merchandising";

export default async function MerchandisingPage() {
  await requireAdmin({ next: "/admin/merchandising" });

  const [merchandising, books, hero] = await Promise.all([getMerchandising(), listAdminBooks(), getHomeHeroForAdmin()]);
  const options = books.map((book) => ({
    id: book.id,
    title: `${book.title}${book.status === "published" ? "" : " (not published)"}`,
  }));

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Storefront" title="Merchandising">
        Choose what the home page features. Books that are not published are skipped on the storefront.
      </AdminPageHeader>
      <div className="space-y-12">
        <AdminSection title="Hero background">
          <p className="mb-5 text-[0.9375rem] leading-relaxed text-ink-soft">
            The editorial photograph behind the home page hero. Set one focal point and one zoom; the desktop (16:9) and
            phone (4:5) crops are rendered from them and uploaded together.
          </p>
          <HeroBackgroundForm hero={hero} />
        </AdminSection>
        <AdminSection title="Featured book">
          <FeaturedBookForm
            action={saveMerchandisingAction.bind(null, "home_featured")}
            books={options}
            featuredBookId={merchandising.featuredBookId}
          />
        </AdminSection>
        <AdminSection title="Home shelf">
          <ShelfForm action={saveMerchandisingAction.bind(null, "home_shelf")} books={options} shelfBookIds={merchandising.shelfBookIds} />
        </AdminSection>
      </div>
    </div>
  );
}
