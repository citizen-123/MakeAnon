#!/bin/bash
set -e

# MakeAnon Database Restore Script
# Usage: ./scripts/restore.sh <backup_file>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -z "$1" ]; then
    echo -e "${RED}Usage: $0 <backup_file>${NC}"
    echo ""
    echo "Available backups:"
    ls -lh "$PROJECT_DIR/backups"/*.sql.gz 2>/dev/null || echo "No backups found"
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo -e "${RED}Backup file not found: $BACKUP_FILE${NC}"
    exit 1
fi

cd "$PROJECT_DIR"

echo -e "${YELLOW}WARNING: This will overwrite the current database!${NC}"
read -p "Are you sure you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Restore cancelled."
    exit 0
fi

echo -e "${YELLOW}Stopping application...${NC}"
docker compose stop app

echo -e "${YELLOW}Restoring database from: $BACKUP_FILE${NC}"

# Drop and recreate database
docker compose exec -T postgres psql -U makeanon -d postgres -c "DROP DATABASE IF EXISTS makeanon;"
docker compose exec -T postgres psql -U makeanon -d postgres -c "CREATE DATABASE makeanon;"

# Restore from backup
gunzip -c "$BACKUP_FILE" | docker compose exec -T postgres psql -U makeanon makeanon

echo -e "${YELLOW}Starting application...${NC}"
docker compose start app

echo -e "${GREEN}Restore complete!${NC}"
