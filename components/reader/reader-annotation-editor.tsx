"use client";

import { useState, type ReactElement } from "react";
import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export type ReaderAnnotationEditorCopy = { addBookmark: string; editBookmark: string; bookmarkLabel: string; bookmarkFallback: string; save: string; cancel: string; note: string; delete: string };
export function ReaderAnnotationEditor({ copy, trigger, mode, chapterTitle = "", initialValue, onSave, onDelete, open, onOpenChange, dark = false, finalFocus }: { copy: ReaderAnnotationEditorCopy; trigger: ReactElement; mode: "bookmark" | "note"; chapterTitle?: string; initialValue?: string | null; onSave: (value: string | null) => void; onDelete?: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; dark?: boolean; finalFocus?: () => HTMLElement | null }) {
  const limit = mode === "bookmark" ? 120 : 5000;
  const [value, setValue] = useState(initialValue ?? (mode === "bookmark" ? chapterTitle || copy.bookmarkFallback : ""));
  const title = mode === "bookmark" ? (initialValue ? copy.editBookmark : copy.addBookmark) : copy.note;
  const valid = mode === "bookmark" ? value.trim().length >= 1 : true;
  return <Dialog onOpenChange={onOpenChange} open={open}><DialogTrigger render={trigger} /><DialogPanel className={dark ? "bg-ink text-ivory" : undefined} finalFocus={finalFocus} side="bottom"><DialogTitle>{title}</DialogTitle><label className="grid gap-2 text-sm text-current">{mode === "bookmark" ? copy.bookmarkLabel : copy.note}<textarea aria-label={mode === "bookmark" ? copy.bookmarkLabel : copy.note} value={value} onChange={(event) => setValue(Array.from(event.target.value).slice(0, limit).join(""))} className={`min-h-11 rounded-md border border-ink/20 p-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest ${dark ? "bg-ink-soft text-ivory" : "bg-white text-ink"}`} /></label><div className="flex gap-2"><DialogClose>{copy.cancel}</DialogClose><DialogClose disabled={!valid} onClick={() => onSave(mode === "note" ? (value === "" ? null : value) : value.trim())}>{copy.save}</DialogClose>{onDelete ? <DialogClose onClick={onDelete}>{copy.delete}</DialogClose> : null}</div></DialogPanel></Dialog>;
}
