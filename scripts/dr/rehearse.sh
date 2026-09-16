#!/usr/bin/env bash
#
# Disaster recovery rehearsal.
#
# Plan reference: V2 sections 27.5, 28.2.
#
# ## Why a rehearsal and not a backup script
#
# Everybody has a backup. The question a rehearsal answers is whether it
# restores, and whether what comes back is the same system: the same figures,
# the same audit trail, the same notice hashes. A backup nobody has restored is
# a belief, not a control.
#
# This script therefore does the whole loop against a *scratch* database:
#
#   1. fingerprint the live data
#   2. back it up
#   3. restore into a separate database
#   4. fingerprint the restore
#   5. compare, and say plainly whether they match
#
# ## Why it never touches the source database
#
# A rehearsal that could damage the thing it is rehearsing for is worse than no
# rehearsal. The restore goes into `<db>_dr_rehearsal`, which is dropped and
# recreated each run. The source is only ever read.
#
# ## What it does not prove
#
# Recovery of object storage (notice PDFs live in S3/MinIO, not in Postgres),
# of the Keycloak realm, or of the Flowable schema's in-flight timers. Those
# are separate restores with separate rehearsals, and this script says so at
# the end rather than letting a green tick imply more than it tested.
#
# Usage:  bash scripts/dr/rehearse.sh
set -euo pipefail

# Git Bash on Windows rewrites anything that looks like a POSIX path before it
# reaches a command, so `/tmp/dr.dump` arrives as `C:/Users/.../dr.dump` and
# pg_dump writes nowhere. The fix has to be surgical: paths *inside* the
# container must survive untouched, while paths on the host still need
# converting. So the exclusion is applied per command rather than exported,
# and the host backup directory defaults to somewhere inside the repository.
in_container() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"; }

CONTAINER="${DR_CONTAINER:-tas-postgres}"
DB_USER="${DB_USER:-tas}"
SOURCE_DB="${DB_NAME:-tax_assessment}"
TARGET_DB="${SOURCE_DB}_dr_rehearsal"
BACKUP_DIR="${DR_BACKUP_DIR:-./.dr-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/${SOURCE_DB}-${STAMP}.dump"

psql_source() { in_container exec "$CONTAINER" psql -U "$DB_USER" -d "$SOURCE_DB" -tAc "$1"; }
psql_target() { in_container exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET_DB" -tAc "$1"; }

# The fingerprint is deliberately about *meaning*, not row counts. Matching
# counts prove a restore copied rows; matching sums and hashes prove it copied
# the right ones. A restore that lost a decimal place would pass a count check.
FINGERPRINT_SQL="
  SELECT 'cases='       || count(*)                                     FROM tax.tax_assessment_case WHERE is_active
  UNION ALL
  SELECT 'net_total='   || COALESCE(sum(net_payable_or_refundable), 0)::text
    FROM tax.tax_calculation_result WHERE is_current
  UNION ALL
  SELECT 'trace_lines=' || count(*)                                     FROM tax.tax_calculation_trace
  UNION ALL
  SELECT 'events='      || count(*)                                     FROM tax.tax_assessment_event
  UNION ALL
  SELECT 'notice_hash=' || COALESCE(md5(string_agg(content_hash, ',' ORDER BY id)), 'none')
    FROM tax.tax_assessment_notice WHERE is_active
  UNION ALL
  SELECT 'payments='    || COALESCE(sum(amount), 0)::text               FROM tax.taxpayer_account_entry WHERE is_active
  UNION ALL
  SELECT 'losses='      || COALESCE(sum(consumed_amount), 0)::text      FROM tax.taxpayer_loss WHERE is_active
  UNION ALL
  SELECT 'permissions=' || count(*)                                     FROM platform.permission WHERE is_active
  ORDER BY 1
"

echo "Disaster recovery rehearsal"
echo "  source: ${SOURCE_DB}   target: ${TARGET_DB}"
echo

mkdir -p "$BACKUP_DIR"

echo "1. Fingerprinting the live data"
BEFORE="$(psql_source "$FINGERPRINT_SQL")"
echo "$BEFORE" | sed 's/^/     /'
echo

echo "2. Backing up"
START=$(date +%s)
in_container exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$SOURCE_DB" -Fc -f /tmp/dr.dump
in_container cp "$CONTAINER:/tmp/dr.dump" "$BACKUP_FILE" >/dev/null
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "     ${BACKUP_FILE} (${SIZE}) in $(( $(date +%s) - START ))s"
echo

echo "3. Restoring into a scratch database"
RESTORE_START=$(date +%s)
in_container exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS ${TARGET_DB}" >/dev/null
in_container exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${TARGET_DB}" >/dev/null
# --no-owner because the restore may run as a different role than the dump was
# taken under, which is the normal case in a real recovery.
in_container exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$TARGET_DB" --no-owner /tmp/dr.dump >/dev/null 2>&1 || true
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_START ))
echo "     restored in ${RESTORE_SECONDS}s"
echo

echo "4. Fingerprinting the restore"
AFTER="$(psql_target "$FINGERPRINT_SQL")"
echo "$AFTER" | sed 's/^/     /'
echo

echo "5. Comparing"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "     MATCH. Every figure, hash and count is identical."
  OUTCOME=0
else
  echo "     MISMATCH:"
  diff <(echo "$BEFORE") <(echo "$AFTER") | sed 's/^/       /' || true
  OUTCOME=1
fi
echo

# The recovery time is the number an operations team actually needs. Reporting
# it every run means a restore that has quietly grown from two minutes to forty
# is visible before the day it matters.
echo "Recovery time for the database: ${RESTORE_SECONDS}s"
echo
echo "Not covered by this rehearsal, and each needing its own:"
echo "  - object storage (notice PDFs live in S3/MinIO, not in Postgres)"
echo "  - the Keycloak realm (users, roles, clients)"
echo "  - Flowable's in-flight timers, which resume from its own schema"

in_container exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS ${TARGET_DB}" >/dev/null
echo
echo "Scratch database dropped."
exit $OUTCOME
