import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { type Locale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

// The body rendered by every `forbidden()` boundary in the app (see lib/auth/admin.ts). Each
// top-level area has its own `forbidden.tsx` convention file - a root layout cannot see a child
// segment's params, and `forbidden()` fires below a root layout - so this is the shared body they
// all render, parameterized on the locale each one resolves for itself.
export async function ForbiddenPage({ locale }: { locale: Locale }) {
  const dictionary = await getDictionary(locale);
  const copy = dictionary.forbidden;
  const home = withLocale(locale, "/");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-ivory px-4 py-12 text-center" id="main-content">
      <Logo href={home} />
      <div className="max-w-[35rem] border-t border-ink pt-8">
        <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">403</p>
        <h1 className="mb-4 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-7 font-serif text-lg text-ink-soft">{copy.description}</p>
        <Link
          className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
          href={home}
        >
          {copy.backHome}
        </Link>
      </div>
    </main>
  );
}
