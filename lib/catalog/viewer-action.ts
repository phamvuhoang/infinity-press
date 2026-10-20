import type { BookAction, BundleAction } from "@/lib/catalog/book-action";

// What the catalog pages' client islands fetch. Deliberately narrow: an action name and whether
// there is a session. No profile, no entitlement rows, no ids the caller did not already have.
export type ViewerBookActionState = { action: BookAction; signedIn: boolean };
export type ViewerBundleActionState = { action: BundleAction; signedIn: boolean; ownedMemberCount: number };
