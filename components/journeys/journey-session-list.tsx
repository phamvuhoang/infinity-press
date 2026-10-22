import Link from "next/link";

import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes } from "@/lib/i18n/routes";

type Copy = Pick<Dictionary["journeys"], "sessionsDone" | "start" | "continue" | "done" | "empty">;

// The journey's sessions with the reader's progress. The public page passes no progress, so its
// link reads "start"; the session page passes the reader's own. A journey whose sessions were all
// deleted still renders: an empty state, and no link to a session that does not exist.
export function JourneySessionList({
  completedPositions,
  copy,
  currentPosition,
  locale,
  sessions,
  slug,
}: {
  completedPositions: number[];
  copy: Copy;
  currentPosition?: number;
  locale: Locale;
  sessions: { position: number; title: string }[];
  slug: string;
}) {
  if (sessions.length === 0) return <p className="text-[0.9375rem] text-ink-soft">{copy.empty}</p>;

  const routes = getCatalogRoutes(locale);
  const completed = new Set(completedPositions);
  const done = sessions.filter((session) => completed.has(session.position)).length;
  const next = sessions.find((session) => !completed.has(session.position));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[0.8125rem] text-sage-text">{fillTemplate(copy.sessionsDone, { done, total: sessions.length })}</p>
        {next ? (
          <Link
            className="inline-flex min-h-11 items-center text-sm font-medium text-forest hover:text-ink"
            href={routes.journeySession(slug, next.position)}
          >
            {done === 0 ? copy.start : copy.continue}
          </Link>
        ) : null}
      </div>
      <ol className="divide-y divide-hairline border-y border-hairline">
        {sessions.map((session) => (
          <li className="flex items-center justify-between gap-4" key={session.position}>
            <Link
              aria-current={session.position === currentPosition ? "page" : undefined}
              className="flex min-h-11 flex-1 items-baseline gap-3 py-2 text-[0.9375rem] hover:text-forest aria-[current=page]:font-medium"
              href={routes.journeySession(slug, session.position)}
            >
              <span className="w-6 shrink-0 text-right text-[0.8125rem] text-sage-text tabular-nums">{session.position}</span>
              <span>{session.title}</span>
            </Link>
            {completed.has(session.position) ? <span className="text-[0.8125rem] text-forest">{copy.done}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
