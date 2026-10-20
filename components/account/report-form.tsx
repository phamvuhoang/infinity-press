"use client";

import { useActionState, useState } from "react";

import type { ReportState } from "@/app/[lang]/(account)/library/report/[editionId]/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { fillTemplate } from "@/lib/i18n/format";

type Copy = {
  messageLabel: string;
  counter: string;
  send: string;
  sent: string;
  errors: Record<NonNullable<ReportState["error"]>, string>;
};

const MAX = 2000;
const initial: ReportState = { status: "idle", error: null };

export function ReportForm({
  action,
  copy,
  place,
}: {
  action: (state: ReportState, formData: FormData) => Promise<ReportState>;
  copy: Copy;
  place: { href: string; progression: string } | null;
}) {
  const [state, formAction] = useActionState(action, initial);
  const [message, setMessage] = useState("");

  if (state.status === "sent") return <p className="mt-8" role="status">{copy.sent}</p>;

  return (
    <form action={formAction} className="mt-8 space-y-4">
      {place ? <input name="href" type="hidden" value={place.href} /> : null}
      {place ? <input name="progression" type="hidden" value={place.progression} /> : null}
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="report-message">{copy.messageLabel}</label>
        <Textarea
          aria-describedby={state.error ? "report-error" : undefined}
          aria-invalid={Boolean(state.error)}
          id="report-message"
          maxLength={MAX}
          name="message"
          onChange={(event) => setMessage(event.target.value)}
          rows={6}
          value={message}
        />
        <p className="text-xs text-sage-text">{fillTemplate(copy.counter, { count: message.length })}</p>
      </div>
      {state.error ? <p className="text-sm text-error" id="report-error" role="alert">{copy.errors[state.error]}</p> : null}
      <SubmitButton className="" pendingLabel="…">{copy.send}</SubmitButton>
    </form>
  );
}
