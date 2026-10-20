import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { UserEntitlements } from "@/components/admin/user-entitlements";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { getAdminUser } from "@/lib/data/users";

export default async function AdminUserPage({ params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  await requireAdmin({ next: `/admin/users/${profileId}` });

  const [user, books] = await Promise.all([getAdminUser(profileId), listAdminBooks()]);

  return (
    <div className="min-w-0 max-w-[56rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="User" title={user.email ?? user.profileId}>
        <p>
          {user.displayName ?? "No display name"} &middot; {user.verified ? "verified email" : "unverified email"}
          {user.isAdmin ? " · admin" : ""}
        </p>
      </AdminPageHeader>
      <AdminSection title="Entitlements">
        <UserEntitlements
          books={books.map((book) => ({ id: book.id, title: book.title }))}
          entitlements={user.entitlements}
          profileId={user.profileId}
        />
      </AdminSection>
    </div>
  );
}
