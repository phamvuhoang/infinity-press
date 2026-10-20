import Link from "next/link";

import { BRAND_NAME } from "@/lib/config/brand";
import { cn } from "@/lib/utils";

// The wordmark is plain text on purpose: there is no logo artwork yet, and the text is the
// accessible name. Every header, footer, and standalone page renders the brand through this component.
export function Logo({
  href,
  className,
  suffix,
  size = "md",
}: {
  href: string;
  className?: string;
  suffix?: string;
  size?: "sm" | "md";
}) {
  return (
    <Link className={cn("inline-flex items-center gap-3 no-underline", className)} href={href}>
      <span className={cn("font-serif tracking-[-0.01em] text-ink", size === "sm" ? "text-base" : "text-lg sm:text-xl")}>
        {BRAND_NAME}
      </span>
      {suffix ? (
        <span className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">{suffix}</span>
      ) : null}
    </Link>
  );
}
