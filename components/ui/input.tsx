import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // Board 1d: white field, Sand hairline, 2px radius; focus turns the border Forest and adds
        // the shared 2px outline; an invalid field takes the Error border.
        "min-h-11 w-full min-w-0 rounded-sm border border-sand bg-white px-3.5 py-2.5 text-base text-ink transition-colors outline-none file:mr-3 file:inline-flex file:h-7 file:rounded-sm file:border file:border-ink file:bg-transparent file:px-3 file:text-sm file:font-medium file:text-ink placeholder:text-sage-text focus-visible:border-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-error md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
