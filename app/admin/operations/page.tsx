import { OperationsPanel } from "@/components/admin/operations-panel";
import { requireAdmin } from "@/lib/auth/admin";
import { loadOperationsAlertState, loadOperationsSnapshot } from "@/lib/data/operations";
import { evaluateOperations } from "@/lib/ops/checks";
import { createClient } from "@/lib/supabase/server";

// Live operational findings for an admin (spec S5 10.3). requireAdmin() gates this page directly
// - the /admin layout is navigation only, never the authorization boundary - and only after it
// passes does this create the admin's normal session client. It never creates a service-role
// client: RLS already lets an admin session read every source table and
// operations_alert_state (proven in supabase/tests). The scheduled worker evaluates the same
// rules with a service-role client after its own bearer-token gate.
//
// Findings are computed fresh on every visit against this request's `now`, so the page always
// reflects the current state rather than the worker's last run - `force-dynamic` keeps Next from
// caching a stale evaluation.
export const dynamic = "force-dynamic";

export default async function AdminOperationsPage() {
  await requireAdmin({ next: "/admin/operations" });
  const supabase = await createClient();
  const now = new Date();

  const [snapshot, alertStates] = await Promise.all([
    loadOperationsSnapshot(supabase, now),
    loadOperationsAlertState(supabase),
  ]);
  const report = evaluateOperations(snapshot, now);

  return <OperationsPanel alertStates={alertStates} now={now} report={report} />;
}
