import Link from "next/link";
import { notFound } from "next/navigation";

import { JourneyReflectionForm } from "@/components/journeys/journey-reflection-form";
import { JourneySessionList } from "@/components/journeys/journey-session-list";
import { SessionCompleteForm } from "@/components/journeys/session-complete-form";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getMyJourneyProgress, getPublishedJourney } from "@/lib/data/journeys";
import { getPassageAnchor } from "@/lib/data/library";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes } from "@/lib/i18n/routes";

import { completeJourneyAction, markSessionAction } from "./actions";

type Props = {
  params: Promise<{ lang: string; slug: string; position: string }>;
};

export default async function JourneySessionPage({ params }: Props) {
  const { lang: locale, slug, position: rawPosition } = await params;
  if (!isLocale(locale)) notFound();
  const routes = getCatalogRoutes(locale);
  // A non-numeric position cannot be a session, but the sign-in gate still comes first.
  const position = /^\d{1,2}$/.test(rawPosition) ? Number(rawPosition) : 0;
  await requireUser(locale, routes.journeySession(slug, position));

  const journey = await getPublishedJourney(locale, slug);
  const session = journey?.sessions.find((candidate) => candidate.position === position);
  if (!journey || !session) notFound();

  const [dictionary, progress, anchor] = await Promise.all([
    getDictionary(locale),
    getMyJourneyProgress(journey.id),
    getPassageAnchor(locale, journey.editionId, session.startLocator),
  ]);
  const copy = dictionary.journeys;
  const isLast = session.position === Math.max(...journey.sessions.map((candidate) => candidate.position));

  // The session's passage when its start href is in the edition's current publication. After an
  // EPUB re-upload it may not be (or the reader does not own the edition): the plain link then opens
  // at the saved position, and can never point at a missing resource.
  const readerHref =
    routes.readEdition(journey.editionId) + (anchor === null ? "" : `?${new URLSearchParams({ anchor: String(anchor) })}`);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <main className="mx-auto max-w-[45rem] px-4 py-10 sm:px-8 lg:py-14" id="main-content">
        <p className="mb-1.5 text-[0.8125rem] text-sage-text">
          <Link className="underline decoration-sand underline-offset-4 hover:text-ink" href={routes.journey(journey.slug)}>
            {journey.title}
          </Link>
          {" · "}
          {fillTemplate(copy.sessionOf, { position: session.position, total: journey.sessions.length })}
        </p>
        <h1 className="mb-6 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.01em]">{session.title}</h1>
        {session.guideMd ? <p className="mb-8 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{session.guideMd}</p> : null}

        <p className="mb-8">
          <Link className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink" href={readerHref}>
            {copy.openReader}
          </Link>
        </p>

        {session.questions.length > 0 ? (
          <section aria-labelledby="session-questions" className="mb-8">
            <h2 className="mb-3 font-serif text-2xl font-normal" id="session-questions">
              {copy.questionsTitle}
            </h2>
            <ul className="list-disc space-y-2 pl-5 text-[0.9375rem] leading-relaxed">
              {session.questions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mb-10 border-t border-hairline pt-6">
          <SessionCompleteForm
            action={markSessionAction.bind(null, locale, journey.slug, journey.id, session.position)}
            copy={copy}
            done={progress.completedPositions.includes(session.position)}
          />
        </div>

        {isLast ? (
          <div className="mb-10">
            <JourneyReflectionForm
              action={completeJourneyAction.bind(null, locale, journey.slug, journey.id, session.position)}
              completed={progress.completed}
              copy={copy}
              reflection={progress.reflection}
            />
          </div>
        ) : null}

        <JourneySessionList
          completedPositions={progress.completedPositions}
          copy={copy}
          currentPosition={session.position}
          locale={locale}
          sessions={journey.sessions}
          slug={journey.slug}
        />
      </main>
    </div>
  );
}
