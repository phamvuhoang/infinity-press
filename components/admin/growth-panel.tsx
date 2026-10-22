import Link from "next/link";

import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { GROWTH_WINDOWS, ratio, type GrowthDays, type GrowthReport } from "@/lib/data/growth";

// Presentational only: app/admin/growth/page.tsx calls requireAdmin() and loads the report.
// Every figure is shown as "n / d" with its denominator; a percentage appears only when d > 0.

function Fraction({ n, d }: { n: number; d: number }) {
  const rate = ratio(n, d);
  return (
    <>
      <span>{`${n} / ${d}`}</span>
      {rate ? <span className="ml-2 text-sage-text">{rate}</span> : null}
    </>
  );
}

const cell = "border-b border-sand px-3 py-2 text-left align-top";

export function GrowthPanel({ days, report }: { days: GrowthDays; report: GrowthReport }) {
  return (
    <div className="max-w-[60rem]">
      <AdminPageHeader eyebrow="Growth" title="Growth">
        <p>Reading activity from analytics events over the last {days} days. Days are UTC.</p>
        <nav aria-label="Report window" className="mt-3 flex gap-4">
          {GROWTH_WINDOWS.map((window) => (
            <Link
              aria-current={window === days ? "page" : undefined}
              className="inline-flex min-h-11 items-center font-medium text-forest underline-offset-4 aria-[current=page]:text-ink aria-[current=page]:underline"
              href={`/admin/growth?days=${window}`}
              key={window}
            >
              {window} days
            </Link>
          ))}
        </nav>
      </AdminPageHeader>

      <div className="flex flex-col gap-12">
        <AdminSection title="Reading funnel by book">
          <p className="mb-4 text-sm text-ink-soft">
            Sample opens count events (visitors may be anonymous). Each later step counts distinct readers, shown against the step before it.
          </p>
          {report.funnel.length === 0 ? (
            <p className="text-sm text-ink-soft">No reading events in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={cell} scope="col">Book</th>
                    <th className={cell} scope="col">Sample opens</th>
                    <th className={cell} scope="col">Opened the reader</th>
                    <th className={cell} scope="col">Completed a session</th>
                    <th className={cell} scope="col">Completed a journey</th>
                  </tr>
                </thead>
                <tbody>
                  {report.funnel.map((row) => (
                    <tr key={row.bookId}>
                      <th className={cell} scope="row">{row.bookTitle}</th>
                      <td className={cell}>{row.openSample}</td>
                      <td className={cell}><Fraction d={row.openSample} n={row.openReader} /></td>
                      <td className={cell}><Fraction d={row.openReader} n={row.sessionCompletedReaders} /></td>
                      <td className={cell}><Fraction d={row.sessionCompletedReaders} n={row.journeyCompleted} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminSection>

        <AdminSection title="Day-7 return">
          <p className="mb-4 text-sm text-ink-soft">
            Readers grouped by the day of their first completed session, and how many opened the reader 6 to 8 days later. Cohorts younger than 8 days are still open.
          </p>
          {report.retention.length === 0 ? (
            <p className="text-sm text-ink-soft">No first sessions in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={cell} scope="col">First session</th>
                  <th className={cell} scope="col">Returned on day 7</th>
                </tr>
              </thead>
              <tbody>
                {report.retention.map((row) => (
                  <tr key={row.cohortDay}>
                    <th className={cell} scope="row"><time dateTime={row.cohortDay}>{row.cohortDay}</time></th>
                    <td className={cell}><Fraction d={row.activated} n={row.returnedD7} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AdminSection>

        <AdminSection title="Shared passages">
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-sage-text">Passages shared</dt>
              <dd className="mt-1 text-lg text-ink">{report.share.shared}</dd>
            </div>
            <div>
              <dt className="text-sage-text">Cards opened</dt>
              <dd className="mt-1 text-lg text-ink"><Fraction d={report.share.shared} n={report.share.opened} /></dd>
            </div>
            <div>
              <dt className="text-sage-text">Continued into the book</dt>
              <dd className="mt-1 text-lg text-ink"><Fraction d={report.share.shared} n={report.share.continued} /></dd>
            </div>
          </dl>
        </AdminSection>
      </div>
    </div>
  );
}
