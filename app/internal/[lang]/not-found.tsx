import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { withInternalLocale } from "@/lib/i18n/config";

// /internal is a staff-only tool and English-only by convention, so this can be a plain server
// component with no request-time API - not-found.tsx accepts no props even under a [lang]
// segment - matching the visual shape of the 403 page so a 404 does not look like a different
// product. "Home" here is the staff sign-in page, not the customer storefront.
export default function NotFound() {
  const home = withInternalLocale("en", "/sign-in");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-ivory px-4 py-12 text-center" id="main-content">
      <Logo href={home} />
      <div className="max-w-[35rem] border-t border-ink pt-8">
        <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">404</p>
        <h1 className="mb-4 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">Page not found</h1>
        <Link
          className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
          href={home}
        >
          Return home
        </Link>
      </div>
    </main>
  );
}
