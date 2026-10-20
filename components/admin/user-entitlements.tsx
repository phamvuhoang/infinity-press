"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { grantComplimentaryEntitlementAction, revokeComplimentaryEntitlementAction, type EntitlementActionResult } from "@/app/admin/users/[profileId]/entitlements/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { AdminUserEntitlementDTO } from "@/lib/data/users";

// "Title (ja)": an entitlement is for one language edition, so the language is always shown.
function entitlementLabel(entitlement: AdminUserEntitlementDTO): string {
  return `${entitlement.bookTitle} (${entitlement.languageCode ?? "no edition"})`;
}

export function UserEntitlements({ profileId, entitlements, editions }: {
  profileId: string;
  entitlements: AdminUserEntitlementDTO[];
  editions: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editionId, setEditionId] = useState(editions[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const messageId = "entitlement-message";

  function run(action: () => Promise<EntitlementActionResult>, success: string, onSuccess?: () => void) {
    if (isPending) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await action();
        setMessage({ text: result.ok ? success : result.error, ok: result.ok });
        if (result.ok) {
          onSuccess?.();
          router.refresh();
        }
      } catch {
        setMessage({ text: "Something went wrong. Try again.", ok: false });
      }
    });
  }

  function revoke(entitlement: AdminUserEntitlementDTO) {
    const revokeReason = window.prompt(`Why revoke access to "${entitlementLabel(entitlement)}"?`, revokeReasons[entitlement.id] ?? "");
    if (revokeReason === null) return;
    setRevokeReasons((previous) => ({ ...previous, [entitlement.id]: revokeReason }));
    run(() => revokeComplimentaryEntitlementAction(profileId, entitlement.id, revokeReason), "Access revoked.", () => {
      setRevokeReasons((previous) => ({ ...previous, [entitlement.id]: "" }));
    });
  }

  return (
    <div className="min-w-0 space-y-8 [overflow-wrap:anywhere]">
      {entitlements.length === 0 ? <p className="text-sm text-sage-text">No entitlements.</p> : (
        <div aria-label="User entitlements" className="relative max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[36rem] table-fixed text-left text-sm">
            <caption className="sr-only">Entitlements for this user</caption>
            <thead><tr className="border-b border-sand text-sage-text">
              <th className="w-1/4 py-2 pr-3 font-medium" scope="col">Edition</th>
              <th className="py-2 pr-3 font-medium" scope="col">Source</th>
              <th className="py-2 pr-3 font-medium" scope="col">Status</th>
              <th className="py-2 pr-3 font-medium" scope="col">Reason</th>
              <th className="w-24 py-2 font-medium" scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>{entitlements.map((entitlement) => (
              <tr className="border-b border-sand" key={entitlement.id}>
                <th className="py-2 pr-3 font-normal" scope="row">{entitlementLabel(entitlement)}</th>
                <td className="py-2 pr-3">{entitlement.sourceType}</td>
                <td className="py-2 pr-3">{entitlement.status}</td>
                <td className="py-2 pr-3">{entitlement.reason ?? "—"}</td>
                <td className="py-2 text-right">{entitlement.status === "active" && entitlement.sourceType === "admin_grant" ? (
                  <Button aria-describedby={message ? messageId : undefined} className="min-h-11" disabled={isPending} onClick={() => revoke(entitlement)} size="sm" type="button" variant="outline">Revoke</Button>
                ) : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <form aria-labelledby="grant-heading" aria-describedby={message ? messageId : undefined} aria-busy={isPending} className="space-y-4 border-t border-sand pt-6" onSubmit={(event) => {
        event.preventDefault();
        if (!editionId || !reason.trim()) return;
        run(() => grantComplimentaryEntitlementAction(profileId, editionId, reason), "Access granted.", () => setReason(""));
      }}>
        <h3 className="text-xs font-medium tracking-wide text-sage-text uppercase" id="grant-heading">Grant complimentary access</h3>
        {editions.length === 0 ? <p className="text-sm text-sage-text">No editions available to grant.</p> : null}
        <div className="min-w-0 space-y-2">
          <Label htmlFor="grant-edition">Edition</Label>
          <NativeSelect className="min-h-11 w-full min-w-0 max-w-full" disabled={isPending || editions.length === 0} id="grant-edition" name="editionId" onChange={(event) => setEditionId(event.target.value)} required value={editionId}>
            {editions.map((edition) => <option key={edition.id} value={edition.id}>{edition.label}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="grant-reason">Reason</Label>
          <Textarea aria-describedby={message && !message.ok ? messageId : undefined} disabled={isPending} id="grant-reason" name="reason" onChange={(event) => setReason(event.target.value)} required rows={2} value={reason} />
        </div>
        <Button className="min-h-11" disabled={isPending || editionId === "" || reason.trim() === ""} type="submit">Grant access</Button>
      </form>
      {message ? <p className="border-l-2 border-forest bg-surface px-4 py-3 text-sm" data-testid="entitlement-message" id={messageId} role={message.ok ? "status" : "alert"}>{message.text}</p> : null}
    </div>
  );
}
