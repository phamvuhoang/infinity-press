"use client";

import { useMemo, useRef, useState } from "react";
import type { HighlightColor } from "@/lib/reader/annotations";
import { buildAttributedQuote, truncateBookQuote } from "@/lib/reader/quote";
import type { ReaderSelection } from "@/lib/reader/types";

export type ReaderSelectionToolbarCopy = { highlightYellow: string; highlightGreen: string; highlightRose: string; addNote: string; copy: string; share: string; askInfinity: string; comingSoon: string; copied: string; copyFailed: string; shareCancelled: string; quoteTruncated: string; shareUnavailable: string; shareCreated: string; sharePublic: string; dismiss: string; annotationTooLong?: string };
type Action = { name: string; color?: HighlightColor; action: "highlight" | "note" | "copy" | "share" | "ask" | "dismiss"; disabled?: boolean };

export function ReaderSelectionToolbar({ copy, selection, book, viewport, touch = false, onHighlight, onAddNote, onDismiss, dark = false, createShareUrl, onBeforeAction }: { copy: ReaderSelectionToolbarCopy; selection: ReaderSelection | null; book: { title: string; author: string; canonicalBookUrl: string }; viewport: { width: number; height: number }; touch?: boolean; onHighlight?: (color: HighlightColor) => void; onAddNote?: () => void; onDismiss?: () => void; dark?: boolean; createShareUrl?: (quote: string) => Promise<string | null>; onBeforeAction?: () => void }) {
  const [message, setMessage] = useState("");
  const [focusedAction, setFocusedAction] = useState(0);
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const quote = useMemo(() => selection ? buildAttributedQuote({ selection: selection.text, ...book }) : null, [book, selection]);
  if (!selection || !quote) return null;
  const actions: Action[] = [
    { name: copy.highlightYellow, color: "yellow", action: "highlight" }, { name: copy.highlightGreen, color: "green", action: "highlight" }, { name: copy.highlightRose, color: "rose", action: "highlight" },
    { name: copy.addNote, action: "note" }, { name: copy.copy, action: "copy" }, { name: copy.share, action: "share" }, { name: copy.askInfinity, action: "ask", disabled: true }, { name: copy.dismiss, action: "dismiss" },
  ];
  // Constrain the first paint to the viewport, then use the actual rendered bar width on later
  // paints. This keeps a selection near either edge reachable even with translated action labels.
  const barWidth = measuredSize.width || viewport.width;
  const barHeight = measuredSize.height || 44;
  const left = Math.max(0, Math.min(selection.rect.x, Math.max(0, viewport.width - barWidth)));
  const top = Math.max(0, Math.min(selection.rect.y - 52, Math.max(0, viewport.height - barHeight)));
  const run = async (action: Action) => {
    if (action.disabled) return;
    if ((action.action === "highlight" || action.action === "note") && (selection.annotationText === null || (selection.annotationText === undefined && Array.from(selection.text).length > 1000))) {
      setMessage(copy.annotationTooLong ?? "");
      return;
    }
    if (action.action === "highlight" && action.color) onHighlight?.(action.color);
    if (action.action === "note") onAddNote?.();
    if (action.action === "dismiss") { onDismiss?.(); return; }
    if (action.action === "copy" || action.action === "share") {
      if (quote.truncated) setMessage(copy.quoteTruncated);
      // Share mints a public card first (S16). Any failure - offline, cap, revoked - falls back to
      // the S5.5 payload with the book URL, and says nothing: sharing never blocks on the server.
      let text = quote.text;
      let created = false;
      if (action.action === "share" && createShareUrl) {
        // Said before the mint, as a label rather than a confirmation: the reader hears that the quote becomes public.
        setMessage([quote.truncated ? copy.quoteTruncated : "", copy.sharePublic].filter(Boolean).join(" "));
        const url = await createShareUrl(truncateBookQuote(selection.text).quote).catch(() => null);
        if (url) { text = buildAttributedQuote({ selection: selection.text, ...book, canonicalBookUrl: url }).text; created = true; }
      }
      const note = [quote.truncated ? copy.quoteTruncated : "", created ? copy.shareCreated : ""].filter(Boolean).join(" ");
      try {
        if (action.action === "share" && typeof navigator.share === "function") {
          try { await navigator.share({ text }); setMessage(note); return; } catch (error) {
            // Cancelling is the reader's choice. Any other rejection (Safari drops user activation
            // after the mint round trip) falls through to the clipboard with the same text.
            if (error instanceof DOMException && error.name === "AbortError") throw error;
          }
        }
        await navigator.clipboard.writeText(text);
        setMessage(action.action === "share" ? [note, copy.shareUnavailable].filter(Boolean).join(" ") : [quote.truncated ? copy.quoteTruncated : "", copy.copied].filter(Boolean).join(" "));
      } catch (error) {
        if (action.action === "share" && error instanceof DOMException && error.name === "AbortError") setMessage(copy.shareCancelled);
        else setMessage(copy.copyFailed);
      }
    }
  };
  const moveFocus = (index: number, direction: 1 | -1) => {
    let next = index;
    do { next = (next + direction + actions.length) % actions.length; } while (actions[next].disabled && next !== index);
    setFocusedAction(next);
    actionRefs.current[next]?.focus();
  };
  return <>
    <div ref={(element) => { const next = element?.getBoundingClientRect(); if (next && (next.width !== measuredSize.width || next.height !== measuredSize.height)) setMeasuredSize({ width: next.width, height: next.height }); }} role="toolbar" aria-label={selection.text} onKeyDownCapture={onBeforeAction} onPointerDownCapture={onBeforeAction} className={`${touch ? "fixed inset-x-0 bottom-0 z-30 flex min-h-11 flex-wrap gap-1 p-3 shadow-drawer" : "fixed z-30 flex min-h-11 max-w-full flex-wrap gap-1 rounded-md p-1 shadow-drawer"} ${dark ? "bg-ink text-ivory" : "bg-white text-ink"}`} style={touch ? undefined : { left, top, maxWidth: viewport.width }}>
      {actions.map((action, index) => <button key={action.name} ref={(element) => { actionRefs.current[index] = element; }} type="button" tabIndex={index === focusedAction ? 0 : -1} disabled={action.disabled} aria-describedby={action.action === "ask" ? "reader-ask-soon" : action.action === "share" && createShareUrl ? "reader-share-public" : undefined} className="min-h-11 rounded-md px-3 text-sm text-current outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-60" onFocus={() => setFocusedAction(index)} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); moveFocus(index, 1); } if (event.key === "ArrowLeft") { event.preventDefault(); moveFocus(index, -1); } }} onClick={action.disabled ? undefined : () => void run(action)}>{action.name}</button>)}
      {createShareUrl ? <span className="sr-only" id="reader-share-public">{copy.sharePublic}</span> : null}
      <p aria-live="polite" role="status" className={message && (message === copy.annotationTooLong || message.includes(copy.sharePublic) || message.includes(copy.shareCreated)) ? "w-full px-3 text-sm" : "sr-only"}>{message}</p>
    </div>
  </>;
}
