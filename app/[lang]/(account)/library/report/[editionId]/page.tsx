import Link from "next/link";
import { notFound } from "next/navigation";

import { ReportForm } from "@/components/account/report-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getReadableEdition } from "@/lib/data/library";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

import { submitReportAction } from "./actions";

const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

// Report a translation error in an edition the reader holds. The reader menu links here with the place
// they were reading; the report goes to the editors, never to the author.
export default async function ReportErrorPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string; editionId: string }>;
  searchParams?: Promise<{ href?: string | string[]; progression?: string | string[] }>;
}) {
  const { lang: locale, editionId } = await params;
  if (!isLocale(locale)) notFound();
  await requireUser(locale, getCatalogRoutes(locale).reportError(editionId));

  // One notFound() for "not yours" and "no such edition": an edition you do not hold looks like none.
  const edition = await getReadableEdition(locale, editionId);
  if (!edition) notFound();

  const query = await searchParams;
  const href = typeof query?.href === "string" ? query.href.slice(0, 500) : "";
  const progression = typeof query?.progression === "string" ? query.progression : "";
  const dictionary = await getDictionary(locale);
  const copy = dictionary.library.report;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8" id="main-content">
        <h1 className="font-serif text-3xl">{copy.title}</h1>
        <p className="mt-3 text-[0.9375rem] text-ink-soft">{fillTemplate(copy.intro, { title: edition.title })}</p>
        {href ? (
          <p className="mt-3 text-xs text-sage-text">
            {copy.place}: {progression ? `${Math.round(Number(progression) * 100)}%` : edition.title}
          </p>
        ) : null}
        <ReportForm
          action={submitReportAction.bind(null, locale, editionId)}
          copy={{ messageLabel: copy.messageLabel, counter: copy.counter, send: copy.send, sent: copy.sent, errors: copy.errors }}
          place={href ? { href, progression } : null}
        />
        <p className="mt-10">
          <Link className={textLink} href={getLocaleRoutes(locale).library}>{copy.back}</Link>
        </p>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
