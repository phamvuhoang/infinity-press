"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { XIcon } from "lucide-react"

// The first overlay primitive in this repo beyond `select`. It exists because the reader's settings
// panel and table-of-contents drawer both need one, and hand-rolling focus trapping, Escape, scroll
// locking and aria-modal twice is how one of the two ends up subtly wrong.
//
// Tokens: `--shadow-drawer` and `--ease-quiet` were defined on the design boards for exactly this
// surface and are used here rather than an ad-hoc shadow.

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-serif text-lg font-normal text-current", className)}
      {...props}
    />
  )
}

function DialogClose({ className, ...props }: DialogPrimitive.Close.Props) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm text-current outline-none transition-colors duration-150 ease-quiet hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest",
        className
      )}
      {...props}
    />
  )
}

// Backdrop and popup together, because a caller has no reason to want one without the other.
// `side` is the only thing the reader's two panels differ on: the drawer comes from the right on a
// wide screen, and both become a bottom sheet under 640px, which is what keeps every control inside
// thumb reach at 390px.
function DialogPanel({
  className,
  children,
  side = "right",
  ...props
}: DialogPrimitive.Popup.Props & { side?: "right" | "bottom" }) {
  return (
    <DialogPortal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-40 bg-ink/20 transition-opacity duration-200 ease-quiet data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-panel"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-5 overflow-y-auto bg-background p-5 text-foreground shadow-drawer outline-none transition-transform duration-200 ease-quiet",
          // Bottom sheet on a phone, whichever side was asked for.
          "inset-x-0 bottom-0 max-h-[80dvh] rounded-t-lg data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full",
          side === "right" &&
            "sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[22rem] sm:rounded-none sm:data-[ending-style]:translate-x-full sm:data-[ending-style]:translate-y-0 sm:data-[starting-style]:translate-x-full sm:data-[starting-style]:translate-y-0",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

export { Dialog, DialogClose, DialogPanel, DialogPortal, DialogTitle, DialogTrigger, XIcon }
