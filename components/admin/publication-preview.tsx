"use client";

import { useState, useTransition } from "react";

import {
  publishPublicationAction,
  rejectPublicationAction,
  rollbackPublicationAction,
} from "@/app/admin/publications/[publicationId]/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PublicationResourceDTO, PublicationVersionSummaryDTO, TocNode } from "@/lib/data/publications";
import { decidePublicationTransition, type PublicationLifecycleState } from "@/lib/publishing/state";

function TocList({ nodes }: { nodes: TocNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-1 border-l border-sand pl-4 text-sm">
      {nodes.map((node) => (
        <li key={`${node.href}-${node.title}`}>
          {node.title || node.href}
          {node.children.length > 0 ? <TocList nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

function previewUrl(publicationId: string, href: string): string {
  const encodedSegments = href.split("/").map(encodeURIComponent).join("/");
  return `/api/admin/publications/${publicationId}/resources/${encodedSegments}`;
}

export function PublicationPreview({
  assetId,
  bookId,
  publicationId,
  lifecycle,
  resources,
  toc,
  versions,
}: {
  assetId: string;
  bookId: string;
  publicationId: string | null;
  lifecycle: PublicationLifecycleState;
  resources: PublicationResourceDTO[];
  toc: TocNode[];
  versions: PublicationVersionSummaryDTO[];
}) {
  const [selectedHref, setSelectedHref] = useState<string | null>(resources[0]?.href ?? null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const canPublish = publicationId !== null && decidePublicationTransition(lifecycle, "publish").allowed;
  const canReject = publicationId !== null && decidePublicationTransition(lifecycle, "reject").allowed;
  // A version is a legitimate rollback target only if it is `superseded` (rollback_publication
  // accepts nothing else) and is not the version already being viewed here.
  const rollbackCandidates = versions.filter(
    (version) =>
      version.assetId !== assetId &&
      version.publicationId !== null &&
      decidePublicationTransition(version.lifecycle, "reactivate").allowed,
  );

  function handlePublish() {
    if (!publicationId) return;
    // Explicit confirmation, per the brief: this moves the book's active pointer, and undoing it
    // means finding and re-approving whatever was active before.
    if (!window.confirm("Publish this version? It will become the book's active version.")) return;
    setMessage(null);
    startTransition(async () => {
      const result = await publishPublicationAction(assetId, bookId, publicationId);
      setMessage(result.ok ? "Published." : result.error);
    });
  }

  function handleRejectConfirm() {
    if (!publicationId) return;
    if (reason.trim().length === 0) {
      setMessage("A reason is required to reject this version.");
      return;
    }
    if (!window.confirm("Reject this version? This cannot be undone.")) return;
    setMessage(null);
    startTransition(async () => {
      const result = await rejectPublicationAction(assetId, publicationId, reason);
      setMessage(result.ok ? "Rejected." : result.error);
      if (result.ok) setRejecting(false);
    });
  }

  function handleRollback(target: PublicationVersionSummaryDTO) {
    if (!target.publicationId) return;
    if (
      !window.confirm(`Roll back to version ${target.version}? It will become the book's active version again.`)
    ) {
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await rollbackPublicationAction(assetId, target.assetId, bookId, target.publicationId!);
      setMessage(result.ok ? `Rolled back to version ${target.version}.` : result.error);
    });
  }

  return (
    <div className="space-y-6">
      {publicationId ? (
        <div className="space-y-3">
          <h3 className="font-serif text-xl font-normal">Preview</h3>
          {resources.length === 0 ? (
            <p className="text-sm text-sage-text">No preview resources are available for this version.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {resources.map((resource) => (
                  <Button
                    key={resource.href}
                    onClick={() => setSelectedHref(resource.href)}
                    type="button"
                    size="sm"
                    variant={resource.href === selectedHref ? "default" : "outline"}
                  >
                    {resource.href}
                  </Button>
                ))}
              </div>
              {selectedHref ? (
                // Keep this frame's classes as they are. Restyling it to `border-hairline bg-white`
                // made Playwright's clicks on Publish/Reject below it stop reaching their handlers
                // (e2e/admin-publication-transitions.spec.ts failed every run; a JS click still
                // worked). The browser-level cause was not pinned down.
                <iframe
                  className="h-[32rem] w-full rounded border"
                  sandbox=""
                  src={previewUrl(publicationId, selectedHref)}
                  title={`Preview of ${selectedHref}`}
                />
              ) : null}
            </>
          )}

          <div className="space-y-1">
            <h4 className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">Table of contents</h4>
            {toc.length > 0 ? (
              <TocList nodes={toc} />
            ) : (
              // Ruling AY: a malformed EPUB3 nav or EPUB2 NCX degrades to toc: [] identically to a
              // book that genuinely has none - this message names both possibilities rather than
              // asserting the one that isn't provable from this data.
              <p className="text-sm text-sage-text">
                No chapters recorded for this version. This can mean the source file has no table
                of contents, or that its navigation could not be parsed.
              </p>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 border-t border-sand pt-6">
        <Button disabled={!canPublish || isPending} onClick={handlePublish} type="button">
          Publish
        </Button>
        <Button
          disabled={!canReject || isPending}
          onClick={() => setRejecting((current) => !current)}
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>

      {rejecting ? (
        <div className="space-y-2">
          <Label htmlFor="rejection-reason">Reason for rejecting this version</Label>
          <Textarea
            id="rejection-reason"
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
          <Button disabled={isPending} onClick={handleRejectConfirm} type="button" variant="destructive">
            Confirm rejection
          </Button>
        </div>
      ) : null}

      {rollbackCandidates.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">Roll back to a previous version</h4>
          <div className="flex flex-wrap gap-2">
            {rollbackCandidates.map((candidate) => (
              <Button
                disabled={isPending}
                key={candidate.assetId}
                onClick={() => handleRollback(candidate)}
                type="button"
                variant="outline"
              >
                Roll back to v{candidate.version}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Fix round 1, Minor #7: publication-status.tsx also renders role="status" nodes for the
          queued/processing lifecycle - a scoped testid, not the bare role, is what keeps this
          locator from tripping Playwright strict mode whenever both happen to be on the page. */}
      {message ? (
        <p className="border-l-2 border-forest bg-surface px-4 py-3 text-sm" data-testid="publication-action-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
