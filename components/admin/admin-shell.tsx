import { AdminNav } from "@/components/admin/admin-nav";
import { Logo } from "@/components/brand/logo";

// Page chrome only, matching the customer SiteHeader + <main id="main-content">
// shell. Renders for every /admin request regardless of role - it carries no
// authorization decision, so removing it would not grant access to anything.
//
// No design board covers the admin yet; this applies the system from boards 1a/1d: the same
// Ivory ground, wordmark, and hairline header as the customer site, marked "Admin".
export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ivory">
      <header className="border-b border-hairline bg-ivory">
        <div className="mx-auto flex min-h-[4.5rem] max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-8 lg:px-16">
          <Logo href="/admin" suffix="Admin" />
          <AdminNav />
        </div>
      </header>
      <main className="mx-auto max-w-[90rem] px-4 py-10 sm:px-8 sm:py-14 lg:px-16" id="main-content">
        {children}
      </main>
    </div>
  );
}
