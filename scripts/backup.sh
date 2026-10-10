#!/bin/bash
# MakeAnon Database Backup Script
#
# Usage: ./scripts/backup.sh [backup_dir]
#
# Cron-safe: uses absolute paths, sets PATH, and talks to the postgres
# container by name (no dependence on cwd or compose project detection).
#
# Example crontab entry (daily at 03:15):
#   15 3 * * * /home/emask/makeanon/scripts/backup.sh >> /home/emask/makeanon/backups/backup.log 2>&1
#
# Old backups are rotated ONLY after the new backup has been verified
# (non-empty, valid gzip, contains the pg_dump completion marker).
# Exits non-zero on any failure.

set -euo pipefail
umask 077

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${1:-$PROJECT_DIR/backups}"
CONTAINER="${POSTGRES_CONTAINER:-makeanon-postgres}"
DB_USER="${DB_USER:-makeanon}"
DB_NAME="${DB_NAME:-makeanon}"
KEEP=14
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/makeanon_$TIMESTAMP.sql.gz"
TMP_FILE="$BACKUP_FILE.partial"

# Colors only when attached to a terminal (keeps cron logs clean)
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; NC=''
fi

log()  { echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { log "${RED}ERROR:${NC} $*" >&2; exit 1; }

cleanup() {
    # Never leave a partial/unverified dump behind
    rm -f "$TMP_FILE"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != "true" ]; then
    fail "Container '$CONTAINER' is not running"
fi

log "${YELLOW}Creating database backup...${NC}"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" | gzip -9 > "$TMP_FILE" \
    || fail "pg_dump failed"

# --- Verify -----------------------------------------------------------------
[ -s "$TMP_FILE" ] || fail "Backup file is empty"
gzip -t "$TMP_FILE" || fail "Backup file failed gzip integrity check"
# (grep without -q so it consumes all input; avoids SIGPIPE false-negatives under pipefail)
if ! gzip -dc "$TMP_FILE" | tail -n 20 | grep "PostgreSQL database dump complete" >/dev/null; then
    fail "Backup is missing the 'PostgreSQL database dump complete' marker (truncated dump?)"
fi

mv "$TMP_FILE" "$BACKUP_FILE"
SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
log "${GREEN}Backup created and verified:${NC} $BACKUP_FILE ($SIZE)"

# --- Rotate (only reached after a verified good backup) ----------------------
log "${YELLOW}Cleaning old backups (keeping last $KEEP)...${NC}"
# Filenames are timestamped, so lexical sort == chronological sort.
mapfile -t OLD < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'makeanon_*.sql.gz' | sort -r | tail -n +$((KEEP + 1)))
for f in "${OLD[@]}"; do
    rm -f -- "$f"
    log "Removed old backup: $f"
done

log "${GREEN}Backup complete!${NC}"
