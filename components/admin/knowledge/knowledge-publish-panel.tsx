"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { publishKnowledgeAction, unpublishKnowledgeAction } from "@/app/admin/knowledge/actions";
import { Button } from "@/components/ui/button";
import {
  articleReadinessIssueMessage,
  articleReadinessIssueSection,
  ideaReadinessIssueMessage,
  ideaReadinessIssueSection,
  type ArticleReadinessIssueCode,
  type IdeaReadinessIssueCode,
} from "@/lib/knowledge/readiness";

type Issue = IdeaReadinessIssueCode | ArticleReadinessIssueCode;

function describe(kind: "idea" | "article", issue: Issue): { message: string; section: string } {
  if (kind === "idea") {
    const code = issue as IdeaReadinessIssueCode;
    return { message: ideaReadinessIssueMessage[code], section: ideaReadinessIssueSection[code] };
  }
  const code = issue as ArticleReadinessIssueCode;
  return { message: articleReadinessIssueMessage[code], section: articleReadinessIssueSection[code] };
}

// The editor's readiness is a preview; publish_idea and publish_article are the gate. Publishing is
// disabled until the preview is clean, and a refusal from the database replaces the preview with
// the database's own issues until the page's data is refreshed.
export function KnowledgePublishPanel({
  kind,
  id,
  status,
  issues,
}: {
  kind: "idea" | "article";
  id: string;
  status: "draft" | "published" | "archived";
  issues: Issue[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string; basedOn: Issue[] } | null>(null);
  const [serverIssues, setServerIssues] = useState<{ values: Issue[]; basedOn: Issue[] } | null>(null);
  const shownIssues = serverIssues?.basedOn === issues ? serverIssues.values : issues;
  const shownMessage = message?.ok || message?.basedOn === issues ? message : null;
  const noun = kind === "idea" ? "idea" : "article";

  function run(action: "publish" | "unpublish") {
    const question =
      action === "publish"
        ? `Publish this ${noun}? It becomes visible on the storefront.`
        : `Unpublish this ${noun}? Its pages disappear from the storefront.`;
    if (!window.confirm(question)) return;

    setMessage(null);
    startTransition(async () => {
      try {
        const result = action === "publish" ? await publishKnowledgeAction(kind, id) : await unpublishKnowledgeAction(kind, id);
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
      <p className="text-sm">
        Status: <span className="font-medium">{status}</span>
      </p>
      {shownIssues.length > 0 ? (
        <div>
          <p className="mb-2 text-sm">Before publishing:</p>
          <ul className="space-y-1 border-l border-sand pl-4 text-sm">
            {shownIssues.map((issue) => {
              const { message: text, section } = describe(kind, issue);
              return (
                <li key={issue}>
                  <a
                    className="inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:decoration-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                    href={`#${section}`}
                  >
                    {text}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-success">Everything required for publishing is in place.</p>
      )}
      <div className="flex flex-wrap gap-3">
        {status === "published" ? (
          <Button disabled={isPending} onClick={() => run("unpublish")} type="button" variant="outline">
            {`Unpublish ${noun}`}
          </Button>
        ) : (
          <Button disabled={isPending || issues.length > 0} onClick={() => run("publish")} type="button">
            {`Publish ${noun}`}
          </Button>
        )}
      </div>
      {shownMessage ? (
        <p
          className={`border-l-2 bg-surface px-4 py-3 text-sm ${shownMessage.ok ? "border-forest" : "border-error text-error"}`}
          data-testid="knowledge-publish-message"
          role={shownMessage.ok ? "status" : "alert"}
        >
          {shownMessage.text}
        </p>
      ) : null}
    </div>
  );
}
