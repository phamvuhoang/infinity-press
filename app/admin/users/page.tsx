import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { searchUsers } from "@/lib/data/users";

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/users" });
  const { q: rawQuery } = await searchParams;
  const q = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const users = q ? await searchUsers(q) : [];

  return (
    <div className="min-w-0 max-w-[48rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Access" title="Users">
        Find a reader by email to review or grant access.
      </AdminPageHeader>
      <form className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="user-search">Email</Label>
          <Input className="min-h-11" defaultValue={q ?? ""} id="user-search" name="q" type="search" />
        </div>
        <Button className="min-h-11" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {q && users.length === 0 ? <p className="text-sage-text">No users match this email. Use at least 3 characters.</p> : null}
      <ul className="border-t border-ink">
        {users.map((user) => (
          <li className="border-b border-sand py-3" key={user.profileId}>
            <Link className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest" href={`/admin/users/${user.profileId}`}>
              {user.email}
            </Link>
            <span className="ml-3 text-sm text-sage-text">
              {user.displayName ?? "No display name"} &middot; {user.verified ? "verified" : "unverified"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
