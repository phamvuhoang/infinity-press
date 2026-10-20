import { BundleReadinessBadge } from "@/components/admin/bundle-editor/readiness-badge";
import type { AdminBundleDTO } from "@/lib/data/bundles";

// Read-only by design, unlike the book editor's details form. The `bundles` table carries nothing
// an operator edits - no canonical key, no unlocalized name, and a status that only publish and
// unpublish may change - so this section states what the bundle is rather than offering fields
// whose only honest behaviour would be to refuse every save.
export function BundleDetails({ bundle }: { bundle: AdminBundleDTO }) {
  const rows: { label: string; value: string }[] = [
    { label: "Identifier", value: bundle.id },
    { label: "Status", value: bundle.status },
    {
      label: "Books",
      value: `${bundle.members.filter((member) => member.published).length} of ${bundle.members.length} published`,
    },
    { label: "Created", value: bundle.createdAt },
    { label: "Last updated", value: bundle.updatedAt },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        {rows.map((row) => (
          <div className="contents" key={row.label}>
            <dt className="text-sage-text">{row.label}</dt>
            <dd className="min-w-0 wrap-anywhere font-mono text-[0.8125rem]">{row.value}</dd>
          </div>
        ))}
      </dl>
      <BundleReadinessBadge readiness={bundle.readiness} />
    </div>
  );
}
