import { savePlatformSettingsAction } from "@/app/admin/settings/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { PlatformSettingsForm } from "@/components/admin/platform-settings-form";
import { requireAdmin } from "@/lib/auth/admin";
import { getPlatformSettings, listContentLanguages } from "@/lib/i18n/settings";

export default async function SettingsPage() {
  await requireAdmin({ next: "/admin/settings" });
  const [settings, contentLanguages] = await Promise.all([getPlatformSettings(), listContentLanguages()]);

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Platform" title="Settings">
        Language defaults for the whole storefront. Adding a new interface language also needs a dictionary and a
        migration; it is not a switch here.
      </AdminPageHeader>
      <AdminSection title="Language defaults">
        <PlatformSettingsForm action={savePlatformSettingsAction} contentLanguages={contentLanguages} settings={settings} />
      </AdminSection>
    </div>
  );
}
