import { EntityNewPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewAuthorPage() {
  await requireAdmin({ next: "/admin/authors/new" });
  return <EntityNewPage type="author" />;
}
