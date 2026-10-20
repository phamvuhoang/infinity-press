"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import type { Locale } from "@/lib/i18n/config";
import { getLocaleRoutes } from "@/lib/i18n/routes";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// The only part of the header that depends on who is asking. It runs in the browser so the rest of
// the header can be prerendered: a server-side session read marks the whole route dynamic and sends
// `private, no-store`. This is presentation only - /[lang]/(account), /[lang]/(reader) and every
// server action still authorize themselves with requireUser().
export function SiteHeaderAccountNav({
  copy,
  current,
  locale,
  navLinkClassName,
}: {
  copy: { account: string; library: string; signIn: string; signOut: string };
  current?: "library" | "account" | "books" | "ideas" | "articles" | "search";
  locale: Locale;
  navLinkClassName: string;
}) {
  // `undefined` means "not known yet". Rendering nothing until the session resolves is deliberate:
  // guessing would show a signed-in reader a Sign in link on first paint.
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.user));
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setSignedIn(Boolean(session?.user));
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  if (signedIn === undefined) return null;

  const routes = getLocaleRoutes(locale);

  if (!signedIn) {
    return (
      <Link className={navLinkClassName} href={routes.signIn}>
        {copy.signIn}
      </Link>
    );
  }

  return (
    <>
      <Link
        aria-current={current === "library" ? "page" : undefined}
        className={cn(navLinkClassName, current === "library" && "underline")}
        href={routes.library}
      >
        {copy.library}
      </Link>
      <Link
        aria-current={current === "account" ? "page" : undefined}
        className={cn(navLinkClassName, current === "account" && "underline")}
        href={routes.account}
      >
        {copy.account}
      </Link>
      <SignOutButton className="hidden sm:inline-flex" label={copy.signOut} locale={locale} variant="ghost" />
    </>
  );
}
