#!/bin/sh
# Nightly pg_dump with retention (TSD Section 11).
#
# Runs as a long-lived sidecar rather than a host cron so the schedule ships with
# the compose file and cannot be forgotten during a rebuild.
#
# The first version of this script piped pg_dump straight into gzip. A live test
# showed why that is unsafe: with the wrong password, pg_dump fails, gzip succeeds,
# the PIPELINE exits 0, and a 20-byte "valid" archive is written - after which
# retention happily deletes the last good backup. So:
#
#   1. dump to a plain temp file and check PG_DUMP's OWN exit code
#   2. verify the dump looks like a real dump before compressing it
#   3. prune old archives ONLY after a verified-good new one exists
#
# STILL REQUIRED, and deliberately not automated here because it needs a credential
# this container should not hold:
#   - sync the backup directory to an off-host bucket (a same-host backup dies with
#     the host, and the rollback ladder plans for exactly that)
#   - restore one dump into a scratch database and confirm it loads; schedule that
#     drill alongside the kill-switch drill
set -eu

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_DIR=/backups
HOUR="${BACKUP_HOUR:-18}"        # 18:00 UTC == 01:00 WIB
MIN_BYTES="${BACKUP_MIN_BYTES:-2048}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] FATAL: DATABASE_URL is not set" >&2
  exit 1
fi

# The store is a managed instance across the VPC, so the dump must use TLS as well.
# Otherwise the nightly backup becomes the one plaintext copy of the entire audit
# trail crossing the network. Respect an sslmode already present in the URL.
CONN="$DATABASE_URL"
case "$CONN" in
  *sslmode=*)
    : ;;                                   # caller has been explicit; leave it alone
  *\?*)
    SEP='&' ;;
  *)
    SEP='?' ;;
esac
if [ -n "${SEP:-}" ]; then
  case "${DATABASE_SSL:-require}" in
    disable)     : ;;
    verify-full) CONN="${CONN}${SEP}sslmode=verify-full&sslrootcert=/secrets/db-ca.pem" ;;
    *)           CONN="${CONN}${SEP}sslmode=require" ;;
  esac
fi

mkdir -p "$BACKUP_DIR"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

run_dump() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  raw="$BACKUP_DIR/.gateway-$stamp.sql"
  target="$BACKUP_DIR/gateway-$stamp.sql.gz"

  # 1. dump to a real file so the exit code is pg_dump's own, not gzip's.
  #    A connection URI carries host, port, user, password, database and sslmode in a
  #    single value, so the backup follows DATABASE_URL to the managed instance and
  #    there is no second copy of the credentials to drift out of sync.
  if ! pg_dump "$CONN" --no-owner --no-privileges > "$raw" 2>"$raw.err"; then
    log "DUMP FAILED: $(tr -d '\n' < "$raw.err" | cut -c1-300)"
    rm -f "$raw" "$raw.err"
    return 1
  fi

  # 2. verify it is a real dump before trusting it
  size=$(wc -c < "$raw" | tr -d ' ')
  if [ "$size" -lt "$MIN_BYTES" ]; then
    log "DUMP REJECTED: only ${size} bytes (min ${MIN_BYTES}); schema may not exist yet"
    rm -f "$raw" "$raw.err"
    return 1
  fi
  if ! grep -q 'PostgreSQL database dump' "$raw"; then
    log "DUMP REJECTED: missing the pg_dump header"
    rm -f "$raw" "$raw.err"
    return 1
  fi
  if ! grep -q 'CREATE TABLE' "$raw"; then
    log "DUMP REJECTED: contains no CREATE TABLE, so it captured no schema"
    rm -f "$raw" "$raw.err"
    return 1
  fi

  gzip -9 -c "$raw" > "$target"
  rm -f "$raw" "$raw.err"
  log "wrote $target ($(wc -c < "$target" | tr -d ' ') bytes compressed from ${size})"

  # 3. prune only now that a verified-good archive exists
  find "$BACKUP_DIR" -name 'gateway-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete 2>/dev/null |
    while read -r old; do log "pruned $old"; done
  return 0
}

log "backup sidecar started (daily at ${HOUR}:00 UTC, retention ${RETENTION_DAYS} days)"

# Take one dump at startup so a fresh deployment is never left without a backup.
# The gateway may still be applying migrations, so retry briefly rather than
# recording an empty database as a successful backup.
attempt=1
while [ "$attempt" -le 10 ]; do
  if run_dump; then break; fi
  log "startup dump attempt ${attempt} did not produce a usable dump; retrying in 15s"
  attempt=$((attempt + 1))
  sleep 15
done

last_run_day=""
while true; do
  now_hour="$(date -u +%H)"
  today="$(date -u +%Y-%m-%d)"
  if [ "$now_hour" = "$HOUR" ] && [ "$today" != "$last_run_day" ]; then
    if run_dump; then
      last_run_day="$today"
    else
      log "scheduled dump failed - will retry on the next tick (ALERT-WORTHY)"
    fi
  fi
  sleep 300
done
