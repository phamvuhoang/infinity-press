"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { publishBundleAction, unpublishBundleAction } from "@/app/admin/bundles/[bundleId]/actions";
import { Button } from "@/components/ui/button";
import {
  bundleReadinessIssueMessage,
  bundleReadinessIssueSection,
  type BundleReadiness,
  type BundleReadinessIssueCode,
} from "@/lib/catalog/bundle-readiness";

function IssueList({ title, issues }: { title: string; issues: BundleReadinessIssueCode[] }) {
  if (issues.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-sm">{title}</p>
      <ul className="space-y-1 border-l border-sand pl-4 text-sm">
        {issues.map((issue) => (
          <li key={issue}>
            <a
              className="inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:decoration-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
              href={`#${bundleReadinessIssueSection[issue]}`}
            >
              {bundleReadinessIssueMessage[issue]}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Readiness is a publish-time gate in the database, but it is a standing verdict here: setting
// members, deactivating the offer, or replacing a cover can each leave an already-published bundle
// below the bar without unpublishing it. So both lists are rendered whatever the status is, rather
// than only while the operator is trying to publish.
export function BundlePublishPanel({
  bundleId,
  status,
  readiness,
}: {
  bundleId: string;
  status: "draft" | "published" | "archived";
  readiness: BundleReadiness;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string; basedOn: BundleReadiness } | null>(null);
  const [serverIssues, setServerIssues] = useState<{ values: BundleReadinessIssueCode[]; basedOn: BundleReadiness } | null>(null);
  // A refreshed server payload supersedes errors raised against the previous editor snapshot.
  const blocking = serverIssues?.basedOn === readiness ? serverIssues.values : readiness.blocking;
  const shownMessage = message?.ok || message?.basedOn === readiness ? message : null;

  function run(kind: "publish" | "unpublish") {
    const question =
      kind === "publish"
        ? "Publish this bundle? It becomes visible on the storefront."
        : "Unpublish this bundle? It disappears from the storefront. Its member books keep selling on their own pages.";
    if (!window.confirm(question)) return;

    setMessage(null);
    startTransition(async () => {
      try {
        const result = kind === "publish" ? await publishBundleAction(bundleId) : await unpublishBundleAction(bundleId);
        if (result.ok) {
          setServerIssues(null);
          setMessage({ ok: true, text: result.message, basedOn: readiness });
          router.refresh();
        } else {
          setServerIssues(result.issues.length > 0 ? { values: result.issues, basedOn: readiness } : null);
          setMessage({ ok: false, text: result.error, basedOn: readiness });
        }
      } catch {
        setMessage({ ok: false, text: "Something went wrong. Try again.", basedOn: readiness });
      }
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <p className="text-sm">
        Status: <span className="font-medium">{status}</span>
      </p>
      {status === "published" && blocking.length > 0 ? (
        <p className="border-l-2 border-error bg-surface px-4 py-3 text-sm text-error" role="alert">
          This bundle is published but no longer meets the publication rules.
        </p>
      ) : null}
      <IssueList issues={blocking} title={status === "published" ? "To meet the publication rules:" : "Before publishing:"} />
      {blocking.length === 0 ? <p className="text-sm text-success">Everything required for publishing is in place.</p> : null}
      <IssueList issues={readiness.warnings} title="Worth knowing:" />
      <div className="flex flex-wrap gap-3">
        {status === "published" ? (
          <Button disabled={isPending} onClick={() => run("unpublish")} type="button" variant="outline">
            Unpublish bundle
          </Button>
        ) : (
          <Button disabled={isPending || blocking.length > 0} onClick={() => run("publish")} type="button">
            Publish bundle
          </Button>
        )}
      </div>
      {shownMessage ? (
        <p
          className={`border-l-2 bg-surface px-4 py-3 text-sm ${shownMessage.ok ? "border-forest" : "border-error text-error"}`}
          data-testid="bundle-publish-message"
          role={shownMessage.ok ? "status" : "alert"}
        >
          {shownMessage.text}
        </p>
      ) : null}
    </div>
  );
}
