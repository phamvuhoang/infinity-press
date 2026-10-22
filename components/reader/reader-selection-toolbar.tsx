"use client";

import { useMemo, useRef, useState } from "react";
import { Dialog, DialogClose, DialogPanel, DialogTitle } from "@/components/ui/dialog";
import type { HighlightColor } from "@/lib/reader/annotations";
import { buildAttributedQuote, MAX_SHARE_QUESTION_CHARS, textKinds, truncateBookQuote, type TextKind } from "@/lib/reader/quote";
import type { ReaderLocator, ReaderSelection } from "@/lib/reader/types";

export type ReaderSelectionToolbarCopy = { highlightYellow: string; highlightGreen: string; highlightRose: string; addNote: string; copy: string; share: string; askInfinity: string; comingSoon: string; copied: string; copyFailed: string; shareCancelled: string; quoteTruncated: string; shareUnavailable: string; shareCreated: string; sharePublic: string; dismiss: string; cancel: string; shareQuestionLabel: string; textKindLabel: string; textKind: Record<TextKind, string>; annotationTooLong?: string };
export type ShareQuoteInput = { quote: string; question?: string; textKind: TextKind; locator: ReaderLocator };
type Action = { name: string; color?: HighlightColor; action: "highlight" | "note" | "copy" | "share" | "ask" | "dismiss"; disabled?: boolean };

export function ReaderSelectionToolbar({ copy, selection, book, viewport, touch = false, onHighlight, onAddNote, onDismiss, dark = false, createShareUrl, onBeforeAction }: { copy: ReaderSelectionToolbarCopy; selection: ReaderSelection | null; book: { title: string; author: string; canonicalBookUrl: string }; viewport: { width: number; height: number }; touch?: boolean; onHighlight?: (color: HighlightColor) => void; onAddNote?: () => void; onDismiss?: () => void; dark?: boolean; createShareUrl?: (input: ShareQuoteInput) => Promise<string | null>; onBeforeAction?: () => void }) {
  const [message, setMessage] = useState("");
  const [focusedAction, setFocusedAction] = useState(0);
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  // S20: Share with a card first asks for an optional question and the kind of text.
  const [shareOpen, setShareOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [textKind, setTextKind] = useState<TextKind>("verbatim");
  // The draft lives only while the dialog is open: every open and close clears it, so a question
  // typed for one passage can never reach the next passage's public page.
  const openShare = (open: boolean) => { setShareOpen(open); setQuestion(""); setTextKind("verbatim"); };
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
  const run = async (action: Action, confirmed = false) => {
    if (action.disabled) return;
    if (action.action === "share" && createShareUrl && !confirmed) { openShare(true); return; }
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
        const asked = question.trim();
        const url = await createShareUrl({ quote: truncateBookQuote(selection.text).quote, ...(asked ? { question: asked } : {}), textKind, locator: selection.locator }).catch(() => null);
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
    {createShareUrl ? <Dialog onOpenChange={openShare} open={shareOpen}><DialogPanel className={dark ? "bg-ink text-ivory" : undefined} side="bottom">
      <DialogTitle>{copy.share}</DialogTitle>
      <p className="text-sm">{copy.sharePublic}</p>
      <label className="grid gap-2 text-sm text-current">{copy.shareQuestionLabel}<textarea maxLength={MAX_SHARE_QUESTION_CHARS} value={question} onChange={(event) => setQuestion(event.target.value)} className={`min-h-11 rounded-md border border-ink/20 p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest ${dark ? "bg-ink-soft text-ivory" : "bg-white text-ink"}`} /></label>
      <fieldset className="text-sm"><legend>{copy.textKindLabel}</legend><div className="flex flex-wrap gap-4">{textKinds.map((kind) => <label className="inline-flex min-h-11 items-center gap-2" key={kind}><input checked={textKind === kind} name="reader-share-text-kind" onChange={() => setTextKind(kind)} type="radio" value={kind} />{copy.textKind[kind]}</label>)}</div></fieldset>
      <div className="flex gap-2"><DialogClose>{copy.cancel}</DialogClose><button className="min-h-11 rounded-md px-3 text-sm text-current outline-none hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" onClick={() => { void run({ name: copy.share, action: "share" }, true); openShare(false); }} type="button">{copy.share}</button></div>
    </DialogPanel></Dialog> : null}
  </>;
}
