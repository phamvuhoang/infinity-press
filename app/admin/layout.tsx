import type { Metadata } from "next";
import "../globals.css";

import { AdminShell } from "@/components/admin/admin-shell";
import { beVietnamPro, lora } from "@/lib/fonts";
import { cn } from "@/lib/utils";

// Keeps the admin out of search results (S5 spec 7.2).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// A root layout: /admin has no [locale] segment and is English-only, so it names its own document
// language. Navigation only. This layout does NOT call requireAdmin() - it is never the
// authorization boundary. Every page and action under /admin calls requireAdmin() itself, so
// removing this file would not grant access to anything it currently protects.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className={cn("font-sans", lora.variable, beVietnamPro.variable)} lang="en">
      <body className="min-h-screen antialiased">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-3 focus:font-medium focus:text-ivory"
          href="#main-content"
        >
          Skip to main content
        </a>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
