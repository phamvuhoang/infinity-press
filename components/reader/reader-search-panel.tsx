"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  parseBoundedReaderLocator,
  type ReaderSearchResult,
} from "@/lib/reader/annotations";
import type { ReaderLocator } from "@/lib/reader/types";

export type ReaderSearchPanelCopy = {
  search: string;
  searchPlaceholder: string;
  searchPrompt: string;
  searching: string;
  searchEmpty: string;
  searchFailed: string;
  retry: string;
  untitledChapter: string;
};

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type SearchState = "idle" | "searching" | "ready" | "error";

const codePointString = (maximum: number) =>
  z.string().refine((value) => Array.from(value).length <= maximum);
const responseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            chapterTitle: codePointString(500).nullable(),
            excerpt: codePointString(240),
            locator: z.unknown(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

function parseSearchResponse(value: unknown): ReaderSearchResult[] {
  return responseSchema.parse(value).results.map((item) => {
    const locator = parseBoundedReaderLocator(item.locator);
    const highlight = locator.text?.highlight;
    if (!highlight || Array.from(highlight).length > 160) {
      throw new Error("Invalid reader search locator");
    }
    return { ...item, locator };
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function ReaderSearchPanel({
  publicationId,
  request,
  onNavigate,
  copy,
}: {
  publicationId: string;
  request: Request;
  onNavigate: (locator: ReaderLocator) => Promise<boolean>;
  copy: ReaderSearchPanelCopy;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>("idle");
  const [results, setResults] = useState<ReaderSearchResult[]>([]);
  const [resultQuery, setResultQuery] = useState<string | null>(null);
  const [resultPublicationId, setResultPublicationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const trimmedQuery = query.trim();
  const queryLength = Array.from(trimmedQuery).length;
  const queryIsValid = queryLength >= 2 && queryLength <= 100;

  const runSearch = useCallback(
    async (searchQuery: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const generation = ++generationRef.current;
      setState("searching");
      try {
        const value = await request<unknown>(
          `/api/reader/publications/${encodeURIComponent(publicationId)}/search?q=${encodeURIComponent(searchQuery)}`,
          { signal: controller.signal },
        );
        const nextResults = parseSearchResponse(value);
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setResults(nextResults);
        setResultQuery(searchQuery);
        setResultPublicationId(publicationId);
        setState("ready");
      } catch (error) {
        if (controller.signal.aborted || generation !== generationRef.current || isAbortError(error)) return;
        setResults([]);
        setResultQuery(searchQuery);
        setResultPublicationId(publicationId);
        setState("error");
      }
    },
    [publicationId, request],
  );

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (!queryIsValid) return;

    const timer = window.setTimeout(() => void runSearch(trimmedQuery), 250);
    return () => {
      window.clearTimeout(timer);
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [queryIsValid, runSearch, trimmedQuery]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ReaderSearchResult[]>();
    if (resultQuery !== trimmedQuery || resultPublicationId !== publicationId) return grouped;
    for (const item of results) {
      const title = item.chapterTitle ?? copy.untitledChapter;
      const entries = grouped.get(title) ?? [];
      entries.push(item);
      grouped.set(title, entries);
    }
    return grouped;
  }, [copy.untitledChapter, publicationId, resultPublicationId, resultQuery, results, trimmedQuery]);

  const visibleState =
    !queryIsValid
      ? "idle"
      : resultQuery === trimmedQuery && resultPublicationId === publicationId
        ? state
        : "searching";

  return (
    <section aria-label={copy.search} className="space-y-4">
      <label className="block text-sm font-medium" htmlFor={`reader-search-${publicationId}`}>
        {copy.search}
      </label>
      <input
        aria-label={copy.search}
        className="min-h-11 w-full rounded-md border border-hairline bg-background px-3 text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        id={`reader-search-${publicationId}`}
        onChange={(event) => {
          const nextQuery = event.currentTarget.value;
          const nextTrimmedQuery = nextQuery.trim();
          if (nextTrimmedQuery === trimmedQuery) {
            setQuery(nextQuery);
            return;
          }

          abortRef.current?.abort();
          generationRef.current += 1;
          const nextLength = Array.from(nextTrimmedQuery).length;
          setResults([]);
          setResultQuery(null);
          setResultPublicationId(null);
          setState(nextLength >= 2 && nextLength <= 100 ? "searching" : "idle");
          setQuery(nextQuery);
        }}
        placeholder={copy.searchPlaceholder}
        type="search"
        value={query}
      />

      {!queryIsValid ? <p className="text-sm text-sage-text">{copy.searchPrompt}</p> : null}
      {queryIsValid && visibleState === "searching" ? (
        <p className="text-sm text-sage-text" role="status">
          {copy.searching}
        </p>
      ) : null}
      {visibleState === "ready" && results.length === 0 ? (
        <p className="text-sm text-sage-text" role="status">
          {copy.searchEmpty}
        </p>
      ) : null}
      {visibleState === "error" ? (
        <div className="space-y-2">
          <p className="text-sm text-error" role="alert">
            {copy.searchFailed}
          </p>
          <Button onClick={() => void runSearch(trimmedQuery)} size="sm" type="button" variant="outline">
            {copy.retry}
          </Button>
        </div>
      ) : null}

      {groups.size > 0 ? (
        <div className="space-y-5">
          {[...groups].map(([chapterTitle, entries]) => (
            <section aria-label={chapterTitle} key={chapterTitle} role="group">
              <h3 className="text-sm font-medium">{chapterTitle}</h3>
              <ul className="mt-2 space-y-1">
                {entries.map((entry, index) => (
                  <li key={`${entry.locator.href}:${entry.locator.progression}:${index}`}>
                    <button
                      className="min-h-11 w-full rounded-sm px-2 py-2 text-left text-sm outline-none hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      onClick={() => void onNavigate(entry.locator)}
                      type="button"
                    >
                      {entry.excerpt}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}
