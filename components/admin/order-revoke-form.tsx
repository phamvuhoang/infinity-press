"use client";

import { useActionState } from "react";

import { revokeOrderAccessAction, type RevokeOrderAccessState } from "@/app/admin/orders/[orderId]/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const initialState: RevokeOrderAccessState = { status: "idle" };

export function OrderRevokeForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(revokeOrderAccessAction.bind(null, orderId), initialState);

  return (
    <form action={formAction} aria-busy={pending} className="max-w-[32rem] space-y-4">
      <div className="space-y-2">
        <Label htmlFor="revoke-reason">Reason</Label>
        <Textarea
          aria-describedby={state.status === "error" ? "revoke-message" : undefined}
          className="min-h-24"
          id="revoke-reason"
          name="reason"
          required
        />
      </div>
      <Button className="min-h-11" disabled={pending} type="submit" variant="destructive">
        {pending ? "Revoking…" : "Revoke access"}
      </Button>
      {state.status === "error" ? (
        <p className="text-[0.8125rem] text-error" id="revoke-message" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "done" ? (
        <p className="text-[0.8125rem] text-success" role="status">
          Access revoked.
        </p>
      ) : null}
    </form>
  );
}
