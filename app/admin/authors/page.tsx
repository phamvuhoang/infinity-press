import { EntityListPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AuthorsPage() {
  await requireAdmin({ next: "/admin/authors" });
  return <EntityListPage type="author" />;
}
