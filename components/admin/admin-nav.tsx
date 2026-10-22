import Link from "next/link";

// Navigation only - rendered inside app/admin/layout.tsx, which is never the
// authorization boundary. Every linked page calls requireAdmin() itself.
const links = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/books", label: "Books" },
  { href: "/admin/bundles", label: "Bundles" },
  { href: "/admin/authors", label: "Authors" },
  { href: "/admin/series", label: "Series" },
  { href: "/admin/topics", label: "Topics" },
  { href: "/admin/ideas", label: "Ideas" },
  { href: "/admin/journeys", label: "Journeys" },
  { href: "/admin/articles", label: "Articles" },
  { href: "/admin/reviews", label: "Reviews" },
  { href: "/admin/feedback", label: "Translation reports" },
  { href: "/admin/questions", label: "Questions" },
  { href: "/admin/quotes", label: "Quotes" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/coupons", label: "Coupons" },
  { href: "/admin/gifts", label: "Gifts" },
  { href: "/admin/merchandising", label: "Merchandising" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/operations", label: "Operations" },
  { href: "/admin/growth", label: "Growth" },
] as const;

export function AdminNav() {
  return (
    <nav aria-label="Admin navigation" className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm font-medium">
      {links.map((link) => (
        <Link
          className="inline-flex min-h-11 items-center text-ink underline-offset-[6px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
          href={link.href}
          key={link.href}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
