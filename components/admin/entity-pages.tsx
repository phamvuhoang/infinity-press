import Link from "next/link";
import { locales, localeRegistry } from "@/lib/i18n/config";
import { missingLocales } from "@/lib/i18n/completeness";

import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { AuthorImageForm } from "@/components/admin/author-image-form";
import { EntityBaseForm, EntityLocalizationForm } from "@/components/admin/localized-entity-form";
import { Button } from "@/components/ui/button";
import { createEntityAction, saveEntityLocalizationAction, updateEntityAction } from "@/app/admin/entities/actions";
import { catalogEntityConfig, type CatalogEntityType } from "@/lib/catalog/entity-types";
import { getAuthorImage } from "@/lib/data/author-image";
import { getCatalogEntity, listCatalogEntities } from "@/lib/data/catalog-entities";

// Page bodies only. Each route file under app/admin/{authors,series,topics} calls requireAdmin()
// itself before rendering one of these; the data functions below call it again.

export async function EntityListPage({ type }: { type: CatalogEntityType }) {
  const config = catalogEntityConfig[type];
  const entities = await listCatalogEntities(type);

  return (
    <div className="max-w-[56rem]">
      <AdminPageHeader eyebrow="Catalog" title={config.plural}>
        <Button render={<Link href={`${config.adminPath}/new`} />}>{`New ${config.singular.toLowerCase()}`}</Button>
      </AdminPageHeader>
      {entities.length === 0 ? (
        <p className="text-sage-text">{`No ${config.plural.toLowerCase()} yet.`}</p>
      ) : (
        <table className="w-full table-fixed border-t border-ink text-left text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
              <th scope="col" className="px-1 py-3 font-medium">Name</th>
              <th scope="col" className="px-1 py-3 font-medium">Slug</th>
              <th scope="col" className="px-1 py-3 font-medium">Languages</th>
              <th scope="col" className="px-1 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((entity) => (
              <tr className="border-b border-sand" key={entity.id}>
                <td className="break-words px-1 py-3">
                  <Link className="inline-flex min-h-11 items-center break-all font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" href={`${config.adminPath}/${entity.id}`}>
                    {entity.name}
                  </Link>
                </td>
                <td className="break-all px-1 py-3 font-mono text-[0.8125rem]">{entity.canonicalSlug}</td>
                <td className="break-words px-1 py-3">{entity.locales.join(", ") || "—"}
                  {missingLocales(entity.locales).length > 0 ? <span className="block text-[0.75rem] text-sage-text">missing {missingLocales(entity.locales).join(", ")}</span> : null}
                </td>
                <td className="break-words px-1 py-3">{entity.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EntityNewPage({ type }: { type: CatalogEntityType }) {
  const config = catalogEntityConfig[type];
  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Catalog" title={`New ${config.singular.toLowerCase()}`}>
        New entries start as drafts. Add copy in each language, then publish.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <EntityBaseForm
          action={createEntityAction.bind(null, type)}
          defaults={{ canonicalSlug: "", name: "", status: "draft" }}
          showStatus={false}
          submitLabel={`Create ${config.singular.toLowerCase()}`}
        />
      </div>
    </div>
  );
}

export async function EntityEditPage({ type, id }: { type: CatalogEntityType; id: string }) {
  const config = catalogEntityConfig[type];
  const entity = await getCatalogEntity(type, id);
  // Only authors carry a portrait, so only authors pay for the extra read.
  const portrait = type === "author" ? await getAuthorImage(id) : null;

  return (
    <div className="min-w-0 max-w-[42.5rem] wrap-anywhere">
      <AdminPageHeader eyebrow={config.singular} title={entity.name}>
        <p>
          {entity.canonicalSlug} &middot; {entity.status}
        </p>
      </AdminPageHeader>
      <div className="space-y-12">
        <AdminSection title="Details">
          <EntityBaseForm
            action={updateEntityAction.bind(null, type, id)}
            defaults={{
              canonicalSlug: entity.canonicalSlug,
              name: entity.name,
              status: entity.status,
              ...(type === "author" ? { acceptsQuestions: entity.acceptsQuestions } : {}),
            }}
            showStatus
            submitLabel="Save"
          />
        </AdminSection>
        {type === "author" ? (
          <AdminSection title="Portrait">
            <p className="mb-5 text-[0.9375rem] leading-relaxed text-ink-soft">
              The photograph beside the author band on the home page. Board 1e crops it to 4:5.
            </p>
            <AuthorImageForm authorId={id} image={portrait} />
          </AdminSection>
        ) : null}
        {locales.map((locale) => (
          <AdminSection key={locale} title={`${localeRegistry[locale].englishName} copy`}>
            <EntityLocalizationForm
              action={saveEntityLocalizationAction.bind(null, type, id, locale)}
              defaults={entity.localizations.find((localization) => localization.locale === locale) ?? null}
              locale={locale}
              showQuote={type === "author"}
            />
          </AdminSection>
        ))}
      </div>
    </div>
  );
}
