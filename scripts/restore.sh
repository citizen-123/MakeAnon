#!/bin/bash
# MakeAnon Database Restore Script
#
# Usage: ./scripts/restore.sh <backup_file.sql.gz>
#
# Safety properties:
#   1. The backup file is validated (gzip integrity + pg_dump completion
#      marker) BEFORE anything is touched.
#   2. A verified safety dump of the current database is taken first.
#   3. The backup is restored into a temporary database with
#      ON_ERROR_STOP=1 in a single transaction. If that fails, the live
#      database and the running app are left untouched.
#   4. Only after a successful restore is the app stopped and the databases
#      swapped by rename. The previous database is kept as
#      makeanon_old_<timestamp> for manual rollback.

set -euo pipefail
umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PG_CONTAINER="${POSTGRES_CONTAINER:-makeanon-postgres}"
APP_CONTAINER="${APP_CONTAINER:-makeanon-app}"
DB_USER="${DB_USER:-makeanon}"
DB_NAME="${DB_NAME:-makeanon}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TMP_DB="${DB_NAME}_restore_${TIMESTAMP}"
OLD_DB="${DB_NAME}_old_${TIMESTAMP}"
SAFETY_DIR="$PROJECT_DIR/backups"
SAFETY_FILE="$SAFETY_DIR/pre-restore_${TIMESTAMP}.sql.gz"
MARKER="PostgreSQL database dump complete"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}$*${NC}"; }
ok()   { echo -e "${GREEN}$*${NC}"; }
fail() { echo -e "${RED}ERROR: $*${NC}" >&2; exit 1; }

psql_admin() {
    docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres "$@"
}

# Validate a gzipped plain-text pg_dump. (grep without -q so the pipeline
# is fully consumed; avoids SIGPIPE false negatives under pipefail.)
validate_dump() {
    local f="$1"
    [ -s "$f" ] || return 1
    gzip -t "$f" || return 1
    gzip -dc "$f" | tail -n 20 | grep "$MARKER" >/dev/null || return 1
}

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
    echo -e "${RED}Usage: $0 <backup_file>${NC}"
    echo ""
    echo "Available backups:"
    ls -lh "$PROJECT_DIR/backups"/*.sql.gz 2>/dev/null || echo "No backups found"
    exit 1
fi

BACKUP_FILE="$1"
[ -f "$BACKUP_FILE" ] || fail "Backup file not found: $BACKUP_FILE"

# --- 1. Validate the backup BEFORE touching anything -------------------------
info "Validating backup file..."
validate_dump "$BACKUP_FILE" \
    || fail "Backup file is empty, corrupt, or truncated (missing '$MARKER'). Aborting; nothing was changed."
ok "Backup file looks valid."

[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" = "true" ] \
    || fail "Postgres container '$PG_CONTAINER' is not running"

echo ""
echo -e "${YELLOW}WARNING: This will replace the current '$DB_NAME' database with:${NC}"
echo "  $BACKUP_FILE"
echo "The app will be stopped briefly during the swap. The current database will be"
echo "kept as '$OLD_DB' and also dumped to $SAFETY_FILE."
read -r -p "Are you sure you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Restore cancelled."
    exit 0
fi

# --- 2. Safety dump of the current database ---------------------------------
info "Taking safety dump of current database -> $SAFETY_FILE"
mkdir -p "$SAFETY_DIR"
docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip > "$SAFETY_FILE" \
    || fail "Safety dump failed. Aborting; nothing was changed."
validate_dump "$SAFETY_FILE" \
    || fail "Safety dump failed verification. Aborting; nothing was changed."
ok "Safety dump verified."

# --- 3. Restore into a temporary database -----------------------------------
cleanup_tmp_db() {
    psql_admin -c "DROP DATABASE IF EXISTS \"$TMP_DB\";" >/dev/null 2>&1 || true
}

info "Creating temporary database $TMP_DB..."
psql_admin -c "CREATE DATABASE \"$TMP_DB\" OWNER \"$DB_USER\";" \
    || fail "Could not create temporary database. Nothing was changed."

info "Restoring backup into $TMP_DB (ON_ERROR_STOP=1, single transaction)..."
if ! gzip -dc "$BACKUP_FILE" | docker exec -i "$PG_CONTAINER" \
        psql -q -v ON_ERROR_STOP=1 --single-transaction -U "$DB_USER" -d "$TMP_DB" >/dev/null; then
    cleanup_tmp_db
    fail "Restore into temporary database failed. Live database and app were NOT touched."
fi
ok "Restore into temporary database succeeded."

# --- 4. Swap: stop app, rename databases, start app -------------------------
info "Stopping application..."
docker stop "$APP_CONTAINER" >/dev/null || true

swap_sql="
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN ('$DB_NAME', '$TMP_DB') AND pid <> pg_backend_pid();
ALTER DATABASE \"$DB_NAME\" RENAME TO \"$OLD_DB\";
ALTER DATABASE \"$TMP_DB\" RENAME TO \"$DB_NAME\";
"
info "Swapping databases ($DB_NAME -> $OLD_DB, $TMP_DB -> $DB_NAME)..."
if ! echo "$swap_sql" | psql_admin >/dev/null; then
    # ALTER DATABASE cannot run in a transaction block, so check state and
    # undo a half-applied swap if necessary.
    echo -e "${RED}Database swap failed. Attempting to roll back...${NC}" >&2
    exists() { psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='$1'" | grep 1 >/dev/null; }
    if ! exists "$DB_NAME" && exists "$OLD_DB"; then
        psql_admin -c "ALTER DATABASE \"$OLD_DB\" RENAME TO \"$DB_NAME\";" || true
    fi
    cleanup_tmp_db
    docker start "$APP_CONTAINER" >/dev/null || true
    fail "Swap failed; original database restored to '$DB_NAME' (verify manually). Safety dump: $SAFETY_FILE"
fi

info "Starting application..."
docker start "$APP_CONTAINER" >/dev/null

ok "Restore complete!"
echo ""
echo "Previous database kept as '$OLD_DB'. Once you've verified the restore, drop it with:"
echo "  docker exec $PG_CONTAINER psql -U $DB_USER -d postgres -c 'DROP DATABASE \"$OLD_DB\";'"
echo "Safety dump: $SAFETY_FILE"
echo ""
echo "Note: Redis may hold cached alias lookups from the previous database. If the"
echo "restored data differs materially, flush the alias cache (or restart redis)."
