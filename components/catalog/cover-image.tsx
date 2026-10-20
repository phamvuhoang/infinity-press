import Image from "next/image";

import { BookCover } from "@/components/brand/book-cover";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { isLoopbackUrl } from "@/lib/config/url";

// A fixed 2:3 box, so covers never shift the layout. Books without a cover fall back to the
// typographic cover. `decorative` covers sit next to their title, so they carry no alt text.
export function CoverImage({
  card,
  sizes,
  size = "md",
  decorative = false,
  preload = false,
}: {
  card: Pick<CatalogBookCard, "bookId" | "title" | "author" | "cover">;
  sizes: string;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
  preload?: boolean;
}) {
  if (!card.cover) {
    return (
      <BookCover
        byline={card.author.name}
        colorKey={card.bookId}
        label={decorative ? null : card.title}
        size={size}
        title={card.title}
      />
    );
  }

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface shadow-cover">
      <Image
        alt={decorative ? "" : card.cover.alt}
        className="object-cover"
        fill
        preload={preload}
        sizes={sizes}
        src={card.cover.url}
        unoptimized={isLoopbackUrl(card.cover.url)}
      />
    </div>
  );
}
