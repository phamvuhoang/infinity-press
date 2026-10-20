// The one place "finished" is defined for TypeScript. Deliberately in lib/reader/ and deliberately
// free of `server-only`: both readers of it are on opposite sides of the network. The reader client
// (components/reader/reader-client.tsx) decides whether to show the completion card, and
// deriveLibraryState (lib/data/library.ts, a server module) decides whether the library shows the
// book as finished. Two surfaces telling the same reader different things about the same book is
// exactly the disagreement this removes.
//
// A THIRD copy lives in SQL, inside save_reading_progress (migration 20260916100000). That one
// cannot import this - SQL cannot call into TypeScript - so the rule is stated in both languages
// and supabase/tests/020_reader_completion.sql is what proves they agree. Change this and you must
// change the migration and that test in the same commit.
export const FINISHED_TOTAL_PROGRESSION = 0.99;
