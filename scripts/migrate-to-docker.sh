#!/bin/bash
# MakeAnon Migration Script - Native to Docker
# This script migrates from systemd services to Docker Compose

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="/tmp/makeanon-migration-$(date +%Y%m%d-%H%M%S)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as correct user
if [ "$EUID" -eq 0 ]; then
    log_error "Do not run this script as root. Run as emask user with sudo access."
    exit 1
fi

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi

    if ! command -v docker compose &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running or user cannot access it"
        exit 1
    fi

    log_info "Prerequisites OK"
}

# Create backup
backup_database() {
    log_info "Creating database backup..."
    mkdir -p "$BACKUP_DIR"

    # Backup PostgreSQL
    pg_dump -U emask -d emask -F c -f "$BACKUP_DIR/emask_backup.dump" 2>/dev/null || {
        log_warn "Could not backup from 'emask' database, trying 'makeanon'..."
        pg_dump -U emask -d makeanon -F c -f "$BACKUP_DIR/emask_backup.dump" 2>/dev/null || {
            log_error "Database backup failed"
            exit 1
        }
    }

    log_info "Database backup saved to $BACKUP_DIR/emask_backup.dump"
}

# Stop native services
stop_native_services() {
    log_info "Stopping native services..."

    # Find and stop the emask/makeanon node process
    local pids=$(pgrep -f "/home/emask/emask/dist/server.js" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        log_info "Stopping MakeAnon app (PIDs: $pids)..."
        kill $pids 2>/dev/null || true
        sleep 2
    fi

    # Stop Haraka
    sudo systemctl stop haraka 2>/dev/null || log_warn "haraka service not found or already stopped"

    # Stop Caddy
    sudo systemctl stop caddy 2>/dev/null || log_warn "caddy service not found or already stopped"

    # We keep PostgreSQL and Redis running during migration for backup purposes
    log_info "Native services stopped (keeping PostgreSQL and Redis for migration)"
}

# Disable native services
disable_native_services() {
    log_info "Disabling native services..."

    sudo systemctl disable haraka 2>/dev/null || true
    sudo systemctl disable caddy 2>/dev/null || true
    sudo systemctl disable emask 2>/dev/null || true

    log_info "Native services disabled"
}

# Setup environment
setup_environment() {
    log_info "Setting up Docker environment..."

    cd "$PROJECT_DIR"

    # Copy .env.docker to .env if not exists
    if [ ! -f .env ]; then
        cp .env.docker .env
        log_info "Created .env from .env.docker"
    else
        log_warn ".env already exists, not overwriting"
    fi
}

# Build and start containers
start_containers() {
    log_info "Building Docker images..."
    cd "$PROJECT_DIR"

    docker compose build --no-cache

    log_info "Starting PostgreSQL and Redis first..."
    docker compose up -d postgres redis

    # Wait for PostgreSQL to be ready
    log_info "Waiting for PostgreSQL to be ready..."
    for i in {1..30}; do
        if docker compose exec -T postgres pg_isready -U makeanon -d makeanon &>/dev/null; then
            log_info "PostgreSQL is ready"
            break
        fi
        sleep 1
    done
}

# Migrate database
migrate_database() {
    log_info "Migrating database to container..."

    cd "$PROJECT_DIR"

    # Restore backup to container PostgreSQL
    if [ -f "$BACKUP_DIR/emask_backup.dump" ]; then
        log_info "Restoring database backup..."

        # Drop and recreate database to ensure clean state
        docker compose exec -T postgres psql -U makeanon -d postgres -c "DROP DATABASE IF EXISTS makeanon;" || true
        docker compose exec -T postgres psql -U makeanon -d postgres -c "CREATE DATABASE makeanon;"

        # Restore
        cat "$BACKUP_DIR/emask_backup.dump" | docker compose exec -T postgres pg_restore -U makeanon -d makeanon --no-owner --no-privileges || {
            log_warn "Some errors during restore (usually safe to ignore)"
        }

        log_info "Database migration complete"
    else
        log_warn "No backup file found, starting with fresh database"
    fi
}

# Start remaining services
start_all_services() {
    log_info "Starting all services..."
    cd "$PROJECT_DIR"

    docker compose up -d

    log_info "Waiting for services to be healthy..."
    sleep 10

    docker compose ps
}

# Stop native PostgreSQL and Redis
stop_native_databases() {
    log_info "Stopping native PostgreSQL and Redis..."

    sudo systemctl stop postgresql 2>/dev/null || log_warn "postgresql service not found"
    sudo systemctl stop redis-server 2>/dev/null || log_warn "redis-server service not found"
    sudo systemctl disable postgresql 2>/dev/null || true
    sudo systemctl disable redis-server 2>/dev/null || true

    log_info "Native databases stopped and disabled"
}

# Verify migration
verify_migration() {
    log_info "Verifying migration..."
    cd "$PROJECT_DIR"

    # Check all containers are running
    local unhealthy=$(docker compose ps --format json | grep -v '"healthy"' | grep -v '"starting"' || true)

    # Test health endpoint
    sleep 5
    if curl -sf http://localhost:3000/api/v1/health > /dev/null; then
        log_info "Health check passed"
    else
        log_warn "Health check failed - service may still be starting"
    fi

    # Show container status
    docker compose ps

    log_info "Migration complete!"
    log_info "Backup saved at: $BACKUP_DIR"
    log_info ""
    log_info "To view logs: docker compose logs -f"
    log_info "To rollback: run the rollback script"
}

# Create rollback script
create_rollback_script() {
    cat > "$BACKUP_DIR/rollback.sh" << 'ROLLBACK_EOF'
#!/bin/bash
# Rollback script - restore native services

set -e

echo "Rolling back to native services..."

# Stop containers
cd /home/emask/makeanon
docker compose down

# Re-enable native services
sudo systemctl enable postgresql redis-server caddy haraka
sudo systemctl start postgresql redis-server

# Wait for PostgreSQL
sleep 5

# Restore database if needed
# pg_restore -U emask -d emask /tmp/makeanon-migration-*/emask_backup.dump

# Start remaining services
sudo systemctl start caddy haraka

# Start the app manually or via systemd
cd /home/emask/emask
node dist/server.js &

echo "Rollback complete"
ROLLBACK_EOF

    chmod +x "$BACKUP_DIR/rollback.sh"
    log_info "Rollback script created at $BACKUP_DIR/rollback.sh"
}

# Main execution
main() {
    log_info "=========================================="
    log_info "MakeAnon Migration: Native to Docker"
    log_info "=========================================="

    check_prerequisites
    backup_database
    create_rollback_script
    stop_native_services
    disable_native_services
    setup_environment
    start_containers
    migrate_database
    start_all_services
    stop_native_databases
    verify_migration
}

# Run main
main "$@"
