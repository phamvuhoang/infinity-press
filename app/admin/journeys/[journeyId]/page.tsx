import { saveJourneyLocalizationAction } from "@/app/admin/journeys/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { JourneyLocalizationForm } from "@/components/admin/journeys/journey-form";
import { JourneyPublishPanel } from "@/components/admin/journeys/journey-publish-panel";
import { SessionEditor } from "@/components/admin/journeys/session-editor";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminJourney } from "@/lib/data/admin-journeys";
import { localeRegistry, locales } from "@/lib/i18n/config";
import { adminRoutes } from "@/lib/i18n/routes";

export default async function AdminJourneyPage({ params }: { params: Promise<{ journeyId: string }> }) {
  const { journeyId } = await params;
  await requireAdmin({ next: adminRoutes.adminJourney(journeyId) });
  const journey = await getAdminJourney(journeyId);
  const title =
    (journey.localizations.find((value) => value.locale === journey.languageCode) ?? journey.localizations[0])?.title ?? journey.slug;
  // Nested entries are indented so the flat picker still reads as the book's outline.
  const tocHrefs = journey.toc.map((entry) => ({ href: entry.href, title: `${" ".repeat(entry.depth)}${entry.title}` }));

  return (
    <div className="max-w-[48rem] min-w-0 [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Journey" title={title}>
        <p>{`${journey.slug} · edition language ${journey.languageCode} · ${journey.sessionCount} sessions`}</p>
      </AdminPageHeader>

      <div className="space-y-12">
        <AdminSection id="localizations" title="Localizations">
          <div className="space-y-12">
            {locales.map((locale) => (
              <div key={locale}>
                <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
                  {localeRegistry[locale].englishName}
                </h3>
                <JourneyLocalizationForm
                  action={saveJourneyLocalizationAction.bind(null, journey.id, locale)}
                  locale={locale}
                  localization={journey.localizations.find((value) => value.locale === locale) ?? null}
                />
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection id="sessions" title="Sessions">
          <SessionEditor journeyId={journey.id} locales={[...locales]} sessions={journey.sessions} tocHrefs={tocHrefs} />
        </AdminSection>

        <AdminSection id="publish" title="Publish">
          {/* Remounts when readiness inputs change, so a stale refusal message does not linger. */}
          <JourneyPublishPanel
            journeyId={journey.id}
            key={`${journey.sessionCount}:${journey.localizations.map((value) => value.locale).join(",")}`}
            status={journey.status}
          />
        </AdminSection>
      </div>
    </div>
  );
}
