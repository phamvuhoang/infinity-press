import { cn } from "@/lib/utils";

// Board 1d's typographic cover: a fixed 2:3 block in one brand colour with the title in Lora.
// It stands in for cover art, which this MVP cannot serve yet (covers live in a private bucket
// with no public route). The colour is derived from a stable key so a book keeps its colour
// across renders and pages.
const tones = {
  forest: "bg-forest text-ivory",
  clay: "bg-clay text-ink",
  sage: "bg-sage text-ivory",
  sand: "bg-sand text-ink",
  parchment: "bg-parchment text-ink",
} as const;

type CoverTone = keyof typeof tones;
const toneNames = Object.keys(tones) as CoverTone[];

function toneFor(key: string): CoverTone {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return toneNames[hash % toneNames.length];
}

export function BookCover({
  title,
  byline,
  colorKey,
  tone,
  label,
  size = "md",
  className,
}: {
  title: string;
  byline?: string;
  colorKey?: string;
  // Fixes the colour instead of deriving it from `colorKey`.
  tone?: CoverTone;
  // Accessible name for the cover. Omitted, the cover is decorative and hidden from assistive
  // technology, because the title is always repeated as text beside it.
  label?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <div
      aria-hidden={label ? undefined : "true"}
      aria-label={label ?? undefined}
      className={cn(
        "flex aspect-[2/3] w-full flex-col justify-between overflow-hidden",
        tones[tone ?? toneFor(colorKey ?? title)],
        size === "sm" && "p-3.5 shadow-cover",
        size === "md" && "p-4 shadow-cover",
        size === "lg" && "p-5 shadow-cover-lg sm:p-6",
        className,
      )}
      role={label ? "img" : undefined}
    >
      <span
        className={cn(
          "font-serif leading-[1.2] break-words",
          size === "sm" && "text-[0.9375rem]",
          size === "md" && "text-[1.125rem]",
          size === "lg" && "text-2xl sm:text-[1.75rem]",
        )}
      >
        {title}
      </span>
      {byline ? (
        <span className="text-[0.625rem] font-medium tracking-[0.1em] uppercase opacity-85">{byline}</span>
      ) : null}
    </div>
  );
}
