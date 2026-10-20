import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 w-full rounded-sm border border-sand bg-white px-3.5 py-2.5 text-base leading-relaxed text-ink transition-colors outline-none placeholder:text-sage-text focus-visible:border-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-error md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
