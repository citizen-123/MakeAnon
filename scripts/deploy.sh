#!/bin/bash
set -e

# MakeAnon Deployment Script
# Usage: ./scripts/deploy.sh [--with-caddy]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}MakeAnon Deployment Script${NC}"
echo "================================"

# Check for .env file
if [ ! -f .env ]; then
    echo -e "${YELLOW}No .env file found. Creating from template...${NC}"
    if [ -f .env.docker.example ]; then
        cp .env.docker.example .env
        echo -e "${RED}Please edit .env with your configuration before continuing.${NC}"
        echo "Required settings:"
        echo "  - DB_PASSWORD"
        echo "  - JWT_SECRET"
        echo "  - SMTP_OUTBOUND_* settings"
        exit 1
    else
        echo -e "${RED}No .env.docker.example found!${NC}"
        exit 1
    fi
fi

# Check for required env vars
source .env
MISSING_VARS=""
[ -z "$DB_PASSWORD" ] && MISSING_VARS="$MISSING_VARS DB_PASSWORD"
[ -z "$JWT_SECRET" ] && MISSING_VARS="$MISSING_VARS JWT_SECRET"

if [ -n "$MISSING_VARS" ]; then
    echo -e "${RED}Missing required environment variables:${NC}$MISSING_VARS"
    echo "Please edit .env and set these values."
    exit 1
fi

# Parse arguments
PROFILE=""
if [ "$1" == "--with-caddy" ]; then
    PROFILE="--profile with-caddy"
    echo -e "${GREEN}Deploying with Caddy reverse proxy${NC}"
fi

# Pull latest images
echo -e "${YELLOW}Pulling latest images...${NC}"
docker compose pull postgres redis

# Build application
echo -e "${YELLOW}Building application...${NC}"
docker compose build app

# Start services
echo -e "${YELLOW}Starting services...${NC}"
docker compose $PROFILE up -d

# Wait for health check
echo -e "${YELLOW}Waiting for application to be healthy...${NC}"
for i in {1..30}; do
    if docker compose exec -T app wget --no-verbose --tries=1 --spider http://localhost:3000/api/v1/health 2>/dev/null; then
        echo -e "${GREEN}Application is healthy!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Application failed to become healthy within 60 seconds${NC}"
        docker compose logs app
        exit 1
    fi
    sleep 2
done

# Show status
echo ""
echo -e "${GREEN}Deployment complete!${NC}"
echo "================================"
docker compose ps

echo ""
echo "Useful commands:"
echo "  View logs:     docker compose logs -f"
echo "  Stop:          docker compose down"
echo "  Restart:       docker compose restart"
echo "  Shell:         docker compose exec app sh"
