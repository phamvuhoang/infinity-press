import Image from "next/image";

import { BookCover } from "@/components/brand/book-cover";
import type { LibraryItemDTO } from "@/lib/data/library";
import { isLoopbackUrl } from "@/lib/config/url";

// The shelf's cover slot: the real cover art when the book has one, and the typographic block
// (components/brand/book-cover.tsx) as the fallback when it does not. Same fixed 2:3 box either
// way, so a missing cover never shifts the shelf's baseline alignment.
//
// The cover sits beside the title everywhere it is used, so the image is decorative and carries
// empty alt text unless the DTO supplies real alt text.
export function LibraryCover({
  item,
  sizes,
  size = "md",
  preload = false,
}: {
  item: Pick<LibraryItemDTO, "bookId" | "title" | "coverUrl" | "coverAltText">;
  sizes: string;
  size?: "sm" | "md" | "lg";
  preload?: boolean;
}) {
  if (!item.coverUrl) {
    return <BookCover colorKey={item.bookId} label={item.coverAltText} size={size} title={item.title} />;
  }

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface shadow-cover">
      <Image
        alt={item.coverAltText ?? ""}
        className="object-cover"
        fill
        preload={preload}
        sizes={sizes}
        src={item.coverUrl}
        unoptimized={isLoopbackUrl(item.coverUrl)}
      />
    </div>
  );
}
