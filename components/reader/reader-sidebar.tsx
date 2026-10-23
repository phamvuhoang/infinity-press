"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";

import type { ReaderAnnotationItem, ReaderAnnotationLoadState } from "@/components/reader/use-reader-annotations";
import type { HighlightColor } from "@/lib/reader/annotations";
import { flattenToc, pathOf } from "@/lib/reader/toc";
import type { ReaderLocator, ReaderTocEntry } from "@/lib/reader/types";

export type ReaderSidebarCopy = {
  contents: string;
  contentsEmpty: string;
  bookmarks: string;
  notes: string;
  highlights: string;
  locationUnavailable: string;
  retry: string;
  delete: string;
  editBookmark: string;
  editNote: string;
  yellow: string;
  green: string;
  rose: string;
  emptyBookmarks: string;
  emptyNotes: string;
  annotationsFailed: string;
  loadingSavedItems: string;
  reportHere: string;
};

// The report form's URL with the place being read. The href is the reader's own (what the report
// form stores in edition_feedback.locator); progression is whole-book progress.
export function reportPlaceHref(reportHref: string, place: { href: string | null; progression?: number | null }): string {
  const query = new URLSearchParams();
  if (place.href) {
    query.set("href", place.href.slice(0, 500));
    if (typeof place.progression === "number" && Number.isFinite(place.progression)) query.set("progression", String(place.progression));
  }
  const search = query.toString();
  return search ? `${reportHref}?${search}` : reportHref;
}

type SidebarTab = "contents" | "bookmarks" | "notes";

type Props = {
  copy: ReaderSidebarCopy;
  dark?: boolean;
  entries: ReaderTocEntry[];
  currentHref: string | null;
  // Whole-book progress at currentHref, sent with a report.
  currentProgression?: number | null;
  // The report form for this edition; null (the sample reader) offers no report link.
  reportHref?: string | null;
  items: ReaderAnnotationItem[];
  loadState: ReaderAnnotationLoadState;
  activeTab?: SidebarTab;
  onTabChange?: (tab: SidebarTab) => void;
  onNavigate: (locator: ReaderLocator) => void;
  onNavigateToc: (href: string) => void;
  onRetryLoad: () => void;
  onRetry: (key: string) => void;
  onDelete: (key: string) => void;
  onEditBookmark: (key: string) => void;
  onEditNote: (key: string) => void;
  onRecolor: (key: string, color: HighlightColor) => void;
};

function SavedItemActions({
  copy,
  item,
  onNavigate,
  onRetry,
  onDelete,
  onEditBookmark,
  onEditNote,
  onRecolor,
  dark = false,
}: Pick<Props, "copy" | "dark" | "onNavigate" | "onRetry" | "onDelete" | "onEditBookmark" | "onEditNote" | "onRecolor"> & {
  item: ReaderAnnotationItem;
}) {
  const label = item.annotation.kind === "bookmark" ? item.annotation.label : item.annotation.selectedText;
  return (
    <li className={`border-b py-2 last:border-0 ${dark ? "border-ivory/20" : "border-hairline"}`}>
      <button
        className={`min-h-11 w-full rounded-md px-2 text-left text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 ${dark ? "hover:bg-ivory/10 focus-visible:outline-ivory" : "hover:bg-surface focus-visible:outline-forest"}`}
        onClick={() => onNavigate(item.annotation.locator)}
        type="button"
      >
        {label}
      </button>
      {item.unresolved ? <p className="px-2 text-xs text-error">{copy.locationUnavailable}</p> : null}
      <div className="flex flex-wrap gap-1 px-2">
        {item.status === "unsynced" ? <button className="min-h-11 rounded-md px-2 text-sm" onClick={() => onRetry(item.key)} type="button">{copy.retry}</button> : null}
        {item.annotation.kind === "bookmark" ? (
          <button className="min-h-11 rounded-md px-2 text-sm" onClick={() => onEditBookmark(item.key)} type="button">{copy.editBookmark}</button>
        ) : (
          <>
            <button className="min-h-11 rounded-md px-2 text-sm" onClick={() => onEditNote(item.key)} type="button">{copy.editNote}</button>
            {(["yellow", "green", "rose"] as HighlightColor[]).map((color) => (
              <button className="min-h-11 rounded-md px-2 text-sm" key={color} onClick={() => onRecolor(item.key, color)} type="button">{copy[color]}</button>
            ))}
          </>
        )}
        <button className="min-h-11 rounded-md px-2 text-sm" onClick={() => onDelete(item.key)} type="button">{copy.delete}</button>
      </div>
    </li>
  );
}

/** Shared body for the persistent desktop rail and the compact drawer. */
export function ReaderSidebar({
  copy,
  dark = false,
  entries,
  currentHref,
  currentProgression = null,
  reportHref = null,
  items,
  loadState,
  activeTab,
  onTabChange,
  onNavigate,
  onNavigateToc,
  onRetryLoad,
  onRetry,
  onDelete,
  onEditBookmark,
  onEditNote,
  onRecolor,
}: Props) {
  const [uncontrolledTab, setUncontrolledTab] = useState<SidebarTab>("contents");
  const tab = activeTab ?? uncontrolledTab;
  const tabRefs = useRef(new Map<SidebarTab, HTMLButtonElement>());
  const ids = useId();
  const flatToc = flattenToc(entries);
  const bookmarkItems = items.filter((item) => item.annotation.kind === "bookmark");
  const highlightItems = items.filter((item) => item.annotation.kind === "highlight");
  const noteItems = items.filter((item) => item.annotation.kind === "highlight" && item.annotation.noteText !== null);
  const tabs: Array<{ id: SidebarTab; label: string }> = [
    { id: "contents", label: copy.contents },
    { id: "bookmarks", label: `${copy.bookmarks} (${bookmarkItems.length})` },
    { id: "notes", label: `${copy.notes} (${noteItems.length})` },
  ];

  function select(next: SidebarTab, focus = false) {
    if (activeTab === undefined) setUncontrolledTab(next);
    onTabChange?.(next);
    if (focus) tabRefs.current.get(next)?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((candidate) => candidate.id === tab);
    let next = index;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    select(tabs[next].id, true);
  }

  const currentPath = currentHref ? pathOf(currentHref) : null;
  const panelId = `${ids}-panel`;
  const mutedText = dark ? "text-current opacity-80" : "text-sage-text";
  const interactive = dark
    ? "hover:bg-ivory/10 focus-visible:outline-ivory"
    : "hover:bg-surface focus-visible:outline-forest";
  const focusOutline = dark ? "focus-visible:outline-ivory" : "focus-visible:outline-forest";
  return (
    <section aria-label={copy.contents} className="flex min-h-0 flex-1 flex-col">
      <div aria-label={copy.contents} className="flex border-b border-hairline" onKeyDown={onTabKeyDown} role="tablist">
        {tabs.map((candidate) => (
          <button
            aria-controls={panelId}
            aria-selected={tab === candidate.id}
            className={`min-h-11 flex-1 px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] aria-selected:border-b-2 aria-selected:font-medium ${dark ? "aria-selected:border-ivory focus-visible:outline-ivory" : "aria-selected:border-forest focus-visible:outline-forest"}`}
            id={`${ids}-${candidate.id}`}
            key={candidate.id}
            onClick={() => select(candidate.id)}
            ref={(node) => { if (node) tabRefs.current.set(candidate.id, node); else tabRefs.current.delete(candidate.id); }}
            role="tab"
            tabIndex={tab === candidate.id ? 0 : -1}
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div aria-labelledby={`${ids}-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-3" id={panelId} role="tabpanel">
        {tab === "contents" ? (
          flatToc.length ? <ul>{flatToc.map((entry) => {
            const current = currentPath !== null && pathOf(entry.href) === currentPath;
            return <li key={`${entry.depth}-${entry.href}`}><button {...(current ? { "aria-current": "true" as const } : {})} className={`flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 aria-[current=true]:font-medium ${interactive}`} onClick={() => onNavigateToc(entry.href)} style={{ paddingLeft: `${0.5 + entry.depth * 0.875}rem` }} type="button">{entry.title}</button></li>;
          })}</ul> : <p className={`text-sm ${mutedText}`}>{copy.contentsEmpty}</p>
        ) : loadState === "loading" ? (
          <p className={`text-sm ${mutedText}`} role="status">{copy.loadingSavedItems}</p>
        ) : loadState === "error" ? (
          <div className="space-y-2"><p className="text-sm text-error" role="status">{copy.annotationsFailed}</p><button className={`min-h-11 rounded-md px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 ${focusOutline}`} onClick={onRetryLoad} type="button">{copy.retry}</button></div>
        ) : tab === "bookmarks" ? (
          <div className="space-y-4">
            <section aria-label={copy.bookmarks}>
              <p className="mb-2 text-sm font-medium">{copy.bookmarks} ({bookmarkItems.length})</p>
              {bookmarkItems.length ? <ul>{bookmarkItems.map((item) => <SavedItemActions copy={copy} dark={dark} item={item} key={item.key} onDelete={onDelete} onEditBookmark={onEditBookmark} onEditNote={onEditNote} onNavigate={onNavigate} onRecolor={onRecolor} onRetry={onRetry} />)}</ul> : <p className={`text-sm ${mutedText}`}>{copy.emptyBookmarks}</p>}
            </section>
            <section aria-label={copy.highlights}>
              <p className="mb-2 text-sm font-medium">{copy.highlights} ({highlightItems.length})</p>
              {highlightItems.length ? <ul>{highlightItems.map((item) => <SavedItemActions copy={copy} dark={dark} item={item} key={item.key} onDelete={onDelete} onEditBookmark={onEditBookmark} onEditNote={onEditNote} onNavigate={onNavigate} onRecolor={onRecolor} onRetry={onRetry} />)}</ul> : null}
            </section>
          </div>
        ) : noteItems.length ? <ul>{noteItems.map((item) => <SavedItemActions copy={copy} dark={dark} item={item} key={item.key} onDelete={onDelete} onEditBookmark={onEditBookmark} onEditNote={onEditNote} onNavigate={onNavigate} onRecolor={onRecolor} onRetry={onRetry} />)}</ul> : <p className={`text-sm ${mutedText}`}>{copy.emptyNotes}</p>}
      </div>
      {reportHref ? (
        <a className={`flex min-h-11 items-center border-t border-hairline px-5 text-sm underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${focusOutline}`} href={reportPlaceHref(reportHref, { href: currentHref, progression: currentProgression })}>
          {copy.reportHere}
        </a>
      ) : null}
    </section>
  );
}
