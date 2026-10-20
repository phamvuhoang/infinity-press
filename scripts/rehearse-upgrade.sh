#!/usr/bin/env bash
# Rehearse the Press edition upgrade on legacy (book-scoped) data. LOCAL ONLY: it resets the Supabase
# stack that --workdir names, so point it at a scratch stack you own (see
# docs/runbooks/testing-environments.md), never at another project's or the cloud project.
#
#   scripts/rehearse-upgrade.sh <workdir>
#
# Case 1 (clean): the legacy fixture upgrades and every row maps to its edition.
# Case 2 (ambiguous): an unscoped admin grant on a two-edition book stops the migration, names the
# row, and leaves the schema untouched.
set -euo pipefail

WORKDIR=${1:?usage: rehearse-upgrade.sh <workdir>}
LAST_LEGACY=20261019140000
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT=$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$WORKDIR/supabase/config.toml")
[ -n "$PROJECT" ] || { echo "no project_id in $WORKDIR/supabase/config.toml" >&2; exit 2; }
case "$PROJECT" in
  *-local) ;;
  *) echo "refusing: project_id '$PROJECT' is not a scratch stack (expected *-local)" >&2; exit 2 ;;
esac
DB="supabase_db_$PROJECT"
psql_in() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
reset_to_legacy() { (cd "$WORKDIR" && supabase db reset --workdir . --version "$LAST_LEGACY" >/dev/null 2>&1); }
load() { docker exec -i "$DB" sh -c 'cat > /tmp/fixture.sql' < "$1"; [ "$1" = "$ROOT/fixtures/db/press-legacy-ambiguous.sql" ] && docker cp "$ROOT/fixtures/db/press-legacy-clean.sql" "$DB:/tmp/press-legacy-clean.sql"; psql_in -f /tmp/fixture.sql >/dev/null; }
check() { # check <description> <sql> <expected>
  local got; got=$(psql_in -c "$2")
  if [ "$got" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got '$got', want '$3')"; FAILED=1; fi
}
FAILED=0

echo "== case 1: clean legacy data"
reset_to_legacy
load "$ROOT/fixtures/db/press-legacy-clean.sql"
(cd "$WORKDIR" && supabase migration up --workdir . >/dev/null 2>&1) || { echo "FAIL - migration up failed on clean data"; exit 1; }
check "entitlement mapped to its edition" "select edition_id from public.entitlements where id = 'fa000000-0000-0000-0000-000000000001'" "f4000000-0000-0000-0000-000000000001"
check "library item follows its entitlement" "select edition_id from public.library_items where id = 'fb000000-0000-0000-0000-000000000001'" "f4000000-0000-0000-0000-000000000001"
check "both order items mapped" "select count(*) from public.order_items where edition_id = 'f4000000-0000-0000-0000-000000000001'" "2"
check "edition took the live publication, not the superseded one" "select active_publication_id from public.editions where id = 'f4000000-0000-0000-0000-000000000001'" "f6000000-0000-0000-0000-000000000002"
check "edition is published" "select status from public.editions where id = 'f4000000-0000-0000-0000-000000000001'" "published"
check "progress still points at its original publication" "select publication_id from public.reading_progress" "f6000000-0000-0000-0000-000000000001"
check "annotation untouched" "select count(*) from public.reader_annotations where publication_id = 'f6000000-0000-0000-0000-000000000001'" "1"
check "pending order untouched" "select status || '/' || payment_status from public.orders where id = 'f9000000-0000-0000-0000-000000000002'" "pending/pending"
check "pending gift untouched" "select status from public.gifts" "pending"
check "bundle holds the fixed edition" "select edition_id from public.bundle_editions" "f4000000-0000-0000-0000-000000000001"
check "no entitlement was created by the upgrade" "select count(*) from public.entitlements" "1"

echo "== case 2: ambiguous legacy data"
reset_to_legacy
load "$ROOT/fixtures/db/press-legacy-ambiguous.sql"
if OUT=$(cd "$WORKDIR" && supabase migration up --workdir . 2>&1); then
  echo "FAIL - migration up succeeded despite an ambiguous row"; FAILED=1
else
  echo "$OUT" | grep -q "fa000000-0000-0000-0000-000000000099" && echo "ok   - the failure names the ambiguous entitlement id" || { echo "FAIL - ambiguous id missing from output"; FAILED=1; }
  echo "$OUT" | grep -qi "legacy-r2@example.test" && { echo "FAIL - output leaks an email"; FAILED=1; } || echo "ok   - the report carries no email"
  check "the schema is unchanged after the refused upgrade" "select count(*) from information_schema.columns where table_schema='public' and table_name='editions' and column_name='status'" "0"
fi

[ "$FAILED" = 0 ] && echo "rehearsal passed" || { echo "rehearsal FAILED"; exit 1; }
