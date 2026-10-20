"use client";

import { ListIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { flattenToc, pathOf } from "@/lib/reader/toc";
import type { ReaderTocEntry } from "@/lib/reader/types";

// The table of contents, from the manifest the engine already holds. Entries are buttons rather
// than links: navigating calls engine.goTo, which is an in-place move within the mounted engine, and
// an <a href> to a Route Handler URL would take the reader out of the reader and straight to a raw
// XHTML resource.

export type ReaderTocCopy = {
  contents: string;
  contentsTitle: string;
  contentsEmpty: string;
  close: string;
};

export function ReaderTocDrawer({
  entries,
  currentHref,
  onNavigate,
  copy,
  children,
  open: controlledOpen,
  onOpenChange,
  triggerClassName,
  panelClassName,
  finalFocus,
}: {
  entries: ReaderTocEntry[];
  currentHref: string | null;
  onNavigate: (href: string) => boolean | Promise<boolean>;
  copy: ReaderTocCopy;
  children?: ReactNode | ((close: () => void) => ReactNode);
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  panelClassName?: string;
  finalFocus?: () => HTMLElement | null;
}) {
  // Controlled so choosing an entry can close the drawer: a drawer left open over the page the
  // reader just jumped to hides the thing they asked to see.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const flat = flattenToc(entries);
  const currentPath = currentHref ? pathOf(currentHref) : null;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={copy.contents}
        className={`inline-flex size-11 items-center justify-center rounded-md text-current outline-none transition-colors duration-150 ease-quiet hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${triggerClassName ?? ""}`}
      >
        <ListIcon aria-hidden="true" className="size-5" />
      </DialogTrigger>

      <DialogPanel className={panelClassName} finalFocus={finalFocus} side="right">
        <div className="flex items-center justify-between gap-4">
          <DialogTitle>{copy.contentsTitle}</DialogTitle>
          <DialogClose>{copy.close}</DialogClose>
        </div>

        {typeof children === "function" ? children(() => setOpen(false)) : children ?? (flat.length === 0 ? (
          <p className="text-sm text-sage-text">{copy.contentsEmpty}</p>
        ) : (
          <ul className="-mx-2">
            {flat.map((entry) => {
              const current = currentPath !== null && pathOf(entry.href) === currentPath;
              return (
                <li key={`${entry.depth}-${entry.href}-${entry.title}`}>
                  <button
                    // Only on the current entry: aria-current="false" is announced by some screen
                    // readers, so the attribute is omitted rather than set false.
                    {...(current ? { "aria-current": "true" as const } : {})}
                    // `aria-[current=true]`, not `aria-[current]`: Tailwind's arbitrary aria
                    // variant needs a value to match against.
                    className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm text-current transition-colors duration-150 ease-quiet hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current aria-[current=true]:font-medium aria-[current=true]:text-forest"
                    onClick={() => {
                      void Promise.resolve(onNavigate(entry.href)).then((moved) => {
                        if (moved !== false) setOpen(false);
                      });
                    }}
                    style={{ paddingLeft: `${0.5 + entry.depth * 0.875}rem` }}
                    type="button"
                  >
                    {entry.title}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
      </DialogPanel>
    </Dialog>
  );
}
