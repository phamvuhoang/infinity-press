"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { publishBookAction, unpublishBookAction } from "@/app/admin/books/[bookId]/publish-actions";
import { Button } from "@/components/ui/button";
import { readinessIssueMessage, readinessIssueSection, type ReadinessIssueCode } from "@/lib/catalog/readiness";

export function PublishPanel({ bookId, status, issues }: {
  bookId: string;
  status: "draft" | "published" | "archived";
  issues: ReadinessIssueCode[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string; basedOn: ReadinessIssueCode[] } | null>(null);
  const [serverIssues, setServerIssues] = useState<{ values: ReadinessIssueCode[]; basedOn: ReadinessIssueCode[] } | null>(null);
  // A refreshed server payload supersedes errors from the previous editor snapshot.
  const shownIssues = serverIssues?.basedOn === issues ? serverIssues.values : issues;
  const shownMessage = message?.ok || message?.basedOn === issues ? message : null;

  function run(kind: "publish" | "unpublish") {
    const question = kind === "publish"
      ? "Publish this book? It becomes visible on the storefront."
      : "Unpublish this book? It disappears from the storefront and readers can no longer open it.";
    if (!window.confirm(question)) return;

    setMessage(null);
    startTransition(async () => {
      try {
        const result = kind === "publish" ? await publishBookAction(bookId) : await unpublishBookAction(bookId);
        if (result.ok) {
          setServerIssues(null);
          setMessage({ ok: true, text: result.message, basedOn: issues });
          router.refresh();
        } else {
          setServerIssues(result.issues.length > 0 ? { values: result.issues, basedOn: issues } : null);
          setMessage({ ok: false, text: result.error, basedOn: issues });
        }
      } catch {
        setMessage({ ok: false, text: "Something went wrong. Try again.", basedOn: issues });
      }
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <p className="text-sm">Status: <span className="font-medium">{status}</span></p>
      {shownIssues.length > 0 ? (
        <div>
          <p className="mb-2 text-sm">Before publishing:</p>
          <ul className="space-y-1 border-l border-sand pl-4 text-sm">
            {shownIssues.map((issue) => (
              <li key={issue}>
                <a
                  className="inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:decoration-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                  href={`#${readinessIssueSection[issue]}`}
                >
                  {readinessIssueMessage[issue]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-success">Everything required for publishing is in place.</p>
      )}
      <div className="flex flex-wrap gap-3">
        {status === "published" ? (
          <Button disabled={isPending} onClick={() => run("unpublish")} type="button" variant="outline">Unpublish book</Button>
        ) : (
          <Button disabled={isPending || issues.length > 0} onClick={() => run("publish")} type="button">Publish book</Button>
        )}
      </div>
      {shownMessage ? (
        <p
          className={`border-l-2 bg-surface px-4 py-3 text-sm ${shownMessage.ok ? "border-forest" : "border-error text-error"}`}
          data-testid="book-publish-message"
          role={shownMessage.ok ? "status" : "alert"}
        >
          {shownMessage.text}
        </p>
      ) : null}
    </div>
  );
}
