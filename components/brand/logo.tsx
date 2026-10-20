import Image from "next/image";
import Link from "next/link";

import { cn } from "@/lib/utils";

// The Infinity Books logo: the brand wordmark, trimmed to its artwork with a transparent ground
// (public/brand/infinity-logo.png, 732x138). Every header, footer, and standalone page renders the
// logo through this component.
//
// width/height are the largest display size (28px tall), not the file's pixels: next/image builds
// its 1x/2x srcset from them, so the file's own size would make it serve a 1920px variant.
const LOGO_WIDTH = 149;
const LOGO_HEIGHT = 28;

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
      <Image
        alt="Infinity Books"
        className={cn("w-auto", size === "sm" ? "h-5" : "h-6 sm:h-7")}
        height={LOGO_HEIGHT}
        priority
        src="/brand/infinity-logo.png"
        width={LOGO_WIDTH}
      />
      {suffix ? (
        <span className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">{suffix}</span>
      ) : null}
    </Link>
  );
}
