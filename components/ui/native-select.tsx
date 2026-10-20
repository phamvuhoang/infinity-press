import * as React from "react";
import { cn } from "cn";

// A native <select> styled like Input. Used where a form posts a plain value and tests select by
// label; the Base UI Select stays for richer pickers.
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "min-h-11 w-full rounded-sm border border-sand bg-white px-3.5 py-2.5 text-base text-ink outline-none focus-visible:border-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:opacity-50 aria-invalid:border-error md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
