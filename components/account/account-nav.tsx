import Link from "next/link";

import { cn } from "@/lib/utils";

// The personal-area side navigation from board 1q, limited to the pages that exist.
export function AccountNav({
  items,
  label,
}: {
  items: { href: string; label: string; current: boolean }[];
  label: string;
}) {
  return (
    <nav aria-label={label} className="text-sm lg:sticky lg:top-24 lg:self-start">
      <p className="mb-2 border-b border-ink pb-2 font-medium">{label}</p>
      <ul className="flex gap-6 lg:flex-col lg:gap-0">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              aria-current={item.current ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center hover:text-ink lg:min-h-9",
                item.current ? "font-medium text-ink" : "text-sage-text",
              )}
              href={item.href}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
