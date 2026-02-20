#!/bin/sh
set -e

echo "Starting MakeAnon..."

# Wait for database to be ready
echo "Waiting for database..."
until nc -z ${DB_HOST:-postgres} ${DB_PORT:-5432}; do
  echo "Database is unavailable - sleeping"
  sleep 2
done
echo "Database is ready!"

# Sync database schema
echo "Syncing database schema..."
if ! npx prisma db push --url "$DATABASE_URL" --accept-data-loss; then
  echo "ERROR: Database schema sync failed!"
  echo "If this is a fresh install, ensure DATABASE_URL is correct."
  exit 1
fi

echo "Starting application..."
exec "$@"
