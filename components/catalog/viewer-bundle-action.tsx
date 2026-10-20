"use client";

import { BundleActionControl } from "@/components/catalog/bundle-action-control";
import { useViewerAction } from "@/components/catalog/use-viewer-action";
import type { BundleAction } from "@/lib/catalog/book-action";
import type { ViewerBundleActionState } from "@/lib/catalog/viewer-action";
import type { Locale } from "@/lib/i18n/config";
import { fillTemplate } from "@/lib/i18n/format";
import type { Dictionary } from "@/lib/i18n/dictionary";

// The bundle page prerenders `publicAction` - what an anonymous visitor could do, with nobody
// owning anything - and this corrects it, and the owned-members line beside it, for the reader who
// is signed in or already owns some of the bundle. It never grants anything: buyAction re-checks the
// reader and create_bundle_order re-checks the bundle, the offer and what the reader already owns.
export function ViewerBundleAction({
  bundleId,
  buyAction,
  buyLabel,
  copy,
  libraryLabel,
  libraryPath,
  locale,
  memberCount,
  ownedCopy,
  publicAction,
  signInPath,
}: {
  bundleId: string;
  buyAction: () => Promise<void>;
  buyLabel: string;
  copy: Dictionary["catalog"]["actions"];
  libraryLabel: string;
  libraryPath: string;
  locale: Locale;
  memberCount: number;
  ownedCopy: { ownedAll: string; ownedSome: string };
  publicAction: BundleAction;
  signInPath: string;
}) {
  // Sends the locale it rendered in, so the handler resolves the bundle in that one locale rather
  // than searching every locale for whichever answers first (Ruling 4) - the wrong locale's bundle
  // has a different member list, and so a different owned-of-total denominator.
  const state = useViewerAction<ViewerBundleActionState>(
    `/api/catalog/bundles/${bundleId}/action-state?locale=${locale}`,
    { action: publicAction, signedIn: false, ownedMemberCount: 0 },
  );

  return (
    <>
      <BundleActionControl
        action={state.action}
        buyAction={buyAction}
        buyLabel={buyLabel}
        copy={copy}
        libraryLabel={libraryLabel}
        libraryPath={libraryPath}
        signInPath={signInPath}
        signedIn={state.signedIn}
      />

      {/* Only when there is something to say: a reader who owns none of the bundle is told
          nothing about ownership, and the price note beside the control already covers the rest. */}
      {state.ownedMemberCount > 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          {state.ownedMemberCount >= memberCount
            ? ownedCopy.ownedAll
            : fillTemplate(ownedCopy.ownedSome, { owned: state.ownedMemberCount, total: memberCount })}
        </p>
      ) : null}
    </>
  );
}
