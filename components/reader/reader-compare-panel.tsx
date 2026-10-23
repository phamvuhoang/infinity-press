"use client";

import { useEffect, useState } from "react";

import { withLocale, type Locale } from "@/lib/i18n/config";
import { alignedPassageSchema, type AlignedPassage } from "@/lib/reader/aligned";
import type { ReaderCopy } from "@/lib/reader/copy";
import type { ReaderLocator } from "@/lib/reader/types";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

// The aligned passage of another edition the reader owns, for the place being read. Mounted only
// while its dialog is open, so it looks the place up once per open. Any failure reads as "nothing
// aligned here": compare never gets in the way of reading.
export function ReaderComparePanel({
  copy,
  publicationId,
  locale,
  request,
  currentLocator,
  onOpenOther,
}: {
  copy: Pick<ReaderCopy, "compareNone" | "compareOpenOther" | "searching">;
  publicationId: string;
  locale: Locale;
  request: Request;
  currentLocator: ReaderLocator | null;
  onOpenOther: (href: string) => void;
}) {
  const [passage, setPassage] = useState<AlignedPassage | null | undefined>(currentLocator ? undefined : null);
  const href = currentLocator?.href;
  const progression = currentLocator?.progression;

  useEffect(() => {
    if (href === undefined || progression === undefined) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ href, progression: String(progression) });
    request<{ passage: unknown }>(`/api/reader/publications/${encodeURIComponent(publicationId)}/aligned?${query}`, {
      signal: controller.signal,
    })
      .then((body) => {
        if (!controller.signal.aborted) setPassage(body.passage === null ? null : alignedPassageSchema.parse(body.passage));
      })
      .catch(() => {
        if (!controller.signal.aborted) setPassage(null);
      });
    return () => controller.abort();
  }, [href, progression, publicationId, request]);

  if (passage === undefined) {
    return <p className="text-sm text-sage-text" role="status">{copy.searching}</p>;
  }
  if (passage === null) {
    return <p className="text-sm text-sage-text" role="status">{copy.compareNone}</p>;
  }

  const otherHref = withLocale(locale, `/read/editions/${passage.targetEditionId}?anchor=${passage.targetOrdinal}`);
  return (
    <section className="space-y-4">
      <blockquote className="font-serif text-base leading-relaxed" lang={passage.targetLanguageCode}>
        {passage.text}
      </blockquote>
      <a
        className="inline-flex min-h-11 items-center text-sm underline decoration-sand underline-offset-4"
        href={otherHref}
        onClick={(event) => {
          // Modified clicks open a new tab as usual; a plain click lets the reader save its place first.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onOpenOther(otherHref);
        }}
      >
        {copy.compareOpenOther}
      </a>
    </section>
  );
}
