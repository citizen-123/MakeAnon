#!/bin/bash
set -e

# MakeAnon Database Backup Script
# Usage: ./scripts/backup.sh [backup_dir]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${1:-$PROJECT_DIR/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/makeanon_$TIMESTAMP.sql.gz"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd "$PROJECT_DIR"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

echo -e "${YELLOW}Creating database backup...${NC}"

# Load environment variables
source .env

# Create backup using docker exec
docker compose exec -T postgres pg_dump -U makeanon makeanon | gzip > "$BACKUP_FILE"

# Get file size
SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')

echo -e "${GREEN}Backup created:${NC} $BACKUP_FILE ($SIZE)"

# Keep only last 7 backups
echo -e "${YELLOW}Cleaning old backups (keeping last 7)...${NC}"
ls -t "$BACKUP_DIR"/makeanon_*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm

echo -e "${GREEN}Backup complete!${NC}"
