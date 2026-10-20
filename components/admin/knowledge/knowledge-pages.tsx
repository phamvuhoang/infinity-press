import Link from "next/link";
import { locales, localeRegistry } from "@/lib/i18n/config";
import { missingLocales } from "@/lib/i18n/completeness";

import {
  saveArticleLocalizationAction,
  saveIdeaLocalizationAction,
  saveKnowledgeSeoAction,
  setArticleRelationsAction,
  setIdeaRelationsAction,
  updateArticleDetailsAction,
} from "@/app/admin/knowledge/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { KnowledgeCreateForm } from "@/components/admin/knowledge/knowledge-create-form";
import { KnowledgeArticleDetailsForm } from "@/components/admin/knowledge/knowledge-details-form";
import { KnowledgeLocalizationForm } from "@/components/admin/knowledge/knowledge-localization-form";
import { KnowledgePublishPanel } from "@/components/admin/knowledge/knowledge-publish-panel";
import { KnowledgeRelationsForm } from "@/components/admin/knowledge/knowledge-relations-form";
import { KnowledgeSeoForm } from "@/components/admin/knowledge/knowledge-seo-form";
import { Button } from "@/components/ui/button";
import { listAdminBooks } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";
import { getAdminKnowledge, listAdminKnowledge, type KnowledgeKind } from "@/lib/data/admin-knowledge";
import {
  articleReadinessIssueMessage,
  ideaReadinessIssueMessage,
  type ArticleReadinessIssueCode,
  type IdeaReadinessIssueCode,
  type KnowledgeEditorSection,
} from "@/lib/knowledge/readiness";

// Page bodies only. Each route file under app/admin/{ideas,articles} calls requireAdmin() itself
// before rendering one of these; every data function below calls it again. Admin copy is English.

const copy = {
  idea: { singular: "Idea", plural: "Ideas", path: "/admin/ideas", titleLabel: "Question" },
  article: { singular: "Article", plural: "Articles", path: "/admin/articles", titleLabel: "Title" },
} as const;

const sections: { id: KnowledgeEditorSection; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "localizations", label: "Localizations" },
  { id: "relations", label: "Relations" },
  { id: "seo", label: "SEO" },
  { id: "publish", label: "Publish" },
];


function issueMessage(kind: KnowledgeKind, issue: IdeaReadinessIssueCode | ArticleReadinessIssueCode): string {
  return kind === "idea"
    ? ideaReadinessIssueMessage[issue as IdeaReadinessIssueCode]
    : articleReadinessIssueMessage[issue as ArticleReadinessIssueCode];
}

function KnowledgeReadinessBadge({ kind, issues }: { kind: KnowledgeKind; issues: (IdeaReadinessIssueCode | ArticleReadinessIssueCode)[] }) {
  if (issues.length === 0) {
    return (
      <span className="rounded-full border border-success px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] whitespace-nowrap text-success uppercase">
        Ready to publish
      </span>
    );
  }
  return (
    <span
      className="rounded-full border border-sand px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] whitespace-nowrap text-ink uppercase"
      title={issues.map((issue) => issueMessage(kind, issue)).join("\n")}
    >
      {`${issues.length} to fix`}
    </span>
  );
}

export async function KnowledgeListPage({ kind }: { kind: KnowledgeKind }) {
  const config = copy[kind];
  const entries = await listAdminKnowledge(kind);

  return (
    <div className="max-w-[64rem] min-w-0">
      <AdminPageHeader eyebrow="Knowledge" title={config.plural}>
        <Button render={<Link href={`${config.path}/new`} />}>{`New ${config.singular.toLowerCase()}`}</Button>
      </AdminPageHeader>
      {entries.length === 0 ? (
        <p className="text-sage-text">{`No ${config.plural.toLowerCase()} yet.`}</p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[42rem] table-fixed border-t border-ink text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
                <th className="px-1 py-3 font-medium" scope="col">
                  {config.titleLabel}
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Status
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Languages
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Readiness
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr className="border-b border-sand" key={entry.id}>
                  <th className="min-w-0 px-1 py-3 font-normal wrap-anywhere" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium wrap-anywhere text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                      href={`${config.path}/${entry.id}`}
                    >
                      {entry.title}
                    </Link>
                  </th>
                  <td className="px-1 py-3 wrap-anywhere">{entry.status}</td>
                  <td className="px-1 py-3 wrap-anywhere">{entry.locales.join(", ") || "—"}
                    {missingLocales(entry.locales).length > 0 ? <span className="block text-[0.75rem] text-sage-text">missing {missingLocales(entry.locales).join(", ")}</span> : null}
                  </td>
                  <td className="px-1 py-3">
                    <KnowledgeReadinessBadge issues={entry.readinessIssues} kind={kind} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export async function KnowledgeNewPage({ kind }: { kind: KnowledgeKind }) {
  const config = copy[kind];
  const authors = kind === "article" ? await listCatalogEntityOptions("author") : [];

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Knowledge" title={`New ${config.singular.toLowerCase()}`}>
        {kind === "idea"
          ? "Creates the idea with its first question and short answer. Add body blocks, related books, and SEO in the editor, then publish."
          : "Creates the article with its author, title, and excerpt. Add body blocks, relations, and SEO in the editor, then publish."}
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <KnowledgeCreateForm authors={authors} kind={kind} />
      </div>
    </div>
  );
}

function DetailsList({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
      {rows.map((row) => (
        <div className="contents" key={row.label}>
          <dt className="text-sage-text">{row.label}</dt>
          <dd className="min-w-0 font-mono text-[0.8125rem] wrap-anywhere">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export async function KnowledgeEditPage({ kind, id }: { kind: KnowledgeKind; id: string }) {
  const config = copy[kind];
  const [entry, books, topics, ideas, authors] = await Promise.all([
    getAdminKnowledge(kind, id),
    listAdminBooks(),
    listCatalogEntityOptions("topic"),
    listAdminKnowledge("idea"),
    kind === "article" ? listCatalogEntityOptions("author") : Promise.resolve([]),
  ]);

  const bookOptions = books.map((book) => ({ id: book.id, title: book.title, published: book.status === "published" }));
  // An idea never relates to or embeds itself.
  const ideaOptions = ideas.filter((idea) => idea.id !== entry.id).map((idea) => ({ id: idea.id, title: idea.title }));
  const topicOptions = topics.map((topic) => ({ id: topic.id, name: topic.name }));
  const first = entry.localizations[0];
  const title = first ? ("question" in first ? first.question : first.title) : entry.id;

  return (
    <div className="max-w-[48rem] min-w-0 [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow={config.singular} title={title}>
        <p>{`${entry.localizations.map((localization) => localization.locale).join(", ") || "No languages"} · ${entry.status}`}</p>
      </AdminPageHeader>

      <nav aria-label={`${config.singular} editor sections`} className="mb-10 flex flex-wrap gap-x-5 gap-y-1 border-b border-sand pb-3 text-sm">
        {sections.map((section) => (
          <a
            className="inline-flex min-h-11 items-center text-forest hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
            href={`#${section.id}`}
            key={section.id}
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="space-y-12">
        <AdminSection id="details" title="Details">
          <div className="min-w-0 space-y-6">
            <DetailsList
              rows={[
                { label: "Identifier", value: entry.id },
                { label: "Status", value: entry.status },
                ...(entry.kind === "article" ? [{ label: "First published", value: entry.publishedAt ?? "Not yet" }] : []),
              ]}
            />
            {entry.kind === "article" ? (
              <KnowledgeArticleDetailsForm
                action={updateArticleDetailsAction.bind(null, entry.id)}
                authorId={entry.authorId}
                authors={authors}
              />
            ) : null}
          </div>
        </AdminSection>

        <AdminSection id="localizations" title="Localizations">
          <div className="space-y-12">
            {locales.map((locale) => (
              <div key={locale}>
                <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">{localeRegistry[locale].englishName}</h3>
                <KnowledgeLocalizationForm
                  action={
                    entry.kind === "idea"
                      ? saveIdeaLocalizationAction.bind(null, entry.id, locale)
                      : saveArticleLocalizationAction.bind(null, entry.id, locale)
                  }
                  books={bookOptions}
                  entityId={entry.id}
                  ideas={ideaOptions}
                  kind={kind}
                  locale={locale}
                  localization={entry.localizations.find((localization) => localization.locale === locale) ?? null}
                />
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection id="relations" title="Relations">
          <KnowledgeRelationsForm
            action={entry.kind === "idea" ? setIdeaRelationsAction.bind(null, entry.id) : setArticleRelationsAction.bind(null, entry.id)}
            books={bookOptions}
            defaults={{
              bookIds: entry.bookIds,
              ideaIds: entry.kind === "idea" ? entry.relatedIdeaIds : entry.ideaIds,
              topicIds: entry.topicIds,
            }}
            ideas={ideaOptions}
            kind={kind}
            topics={topicOptions}
          />
        </AdminSection>

        <AdminSection id="seo" title="SEO">
          <div className="space-y-12">
            {locales.map((locale) => {
              const localization = entry.localizations.find((value) => value.locale === locale) ?? null;
              return (
                <div key={locale}>
                  <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">{localeRegistry[locale].englishName}</h3>
                  <KnowledgeSeoForm
                    action={saveKnowledgeSeoAction.bind(null, kind, entry.id, locale)}
                    defaults={{ seoTitle: localization?.seoTitle ?? null, seoDescription: localization?.seoDescription ?? null }}
                    hasLocalization={localization !== null}
                    locale={locale}
                  />
                </div>
              );
            })}
          </div>
        </AdminSection>

        <AdminSection id="publish" title="Publish">
          <KnowledgePublishPanel id={entry.id} issues={entry.readinessIssues} kind={kind} status={entry.status} />
        </AdminSection>
      </div>
    </div>
  );
}
