"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setJourneyStatusAction } from "@/app/admin/journeys/actions";
import { Button } from "@/components/ui/button";
import type { JourneyStatus } from "@/lib/data/admin-journeys";

const statusLabel: Record<JourneyStatus, string> = { draft: "Draft", published: "Published", archived: "Archived" };

export function JourneyStatusBadge({ status }: { status: JourneyStatus }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] whitespace-nowrap uppercase ${status === "published" ? "border-success text-success" : "border-sand text-ink"}`}
      data-testid="journey-status"
    >
      {statusLabel[status]}
    </span>
  );
}

// setJourneyStatus is the readiness gate; a refusal shows its JourneyNotReadyError message here.
export function JourneyPublishPanel({ journeyId, status }: { journeyId: string; status: JourneyStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function run(next: JourneyStatus, question: string) {
    if (!window.confirm(question)) return;
    setMessage(null);
    startTransition(async () => {
      const result = await setJourneyStatusAction(journeyId, next);
      if (result.ok) router.refresh();
      else setMessage(result.message);
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <p className="flex items-center gap-3 text-sm">
        Status: <JourneyStatusBadge status={status} />
      </p>
      <div className="flex flex-wrap gap-3">
        {status !== "published" ? (
          <Button disabled={isPending} onClick={() => run("published", "Publish this journey? Readers can start it.")} type="button">
            Publish journey
          </Button>
        ) : (
          <Button disabled={isPending} onClick={() => run("draft", "Move this journey back to draft? Readers can no longer open it.")} type="button" variant="outline">
            Move to draft
          </Button>
        )}
        {status !== "archived" ? (
          <Button disabled={isPending} onClick={() => run("archived", "Archive this journey?")} type="button" variant="outline">
            Archive journey
          </Button>
        ) : null}
      </div>
      {message ? (
        <p className="border-l-2 border-error bg-surface px-4 py-3 text-sm text-error" data-testid="journey-publish-message" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
