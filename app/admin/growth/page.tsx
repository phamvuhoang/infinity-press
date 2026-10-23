import { GrowthPanel } from "@/components/admin/growth-panel";
import { requireAdmin } from "@/lib/auth/admin";
import { getGrowthReport, type GrowthDays } from "@/lib/data/growth";

// S20 growth report. requireAdmin() gates this page directly - the /admin layout is navigation
// only - and getGrowthReport() checks again before it reads. The figures move with every event, so
// nothing is cached.
export const dynamic = "force-dynamic";

export default async function AdminGrowthPage({ searchParams }: { searchParams: Promise<{ days?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/growth" });
  const { days: rawDays } = await searchParams;
  const days: GrowthDays = rawDays === "90" ? 90 : 30;
  const report = await getGrowthReport(days);
  return <GrowthPanel days={days} report={report} />;
}
