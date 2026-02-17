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

# Run database migrations
echo "Running database migrations..."
if ! npx prisma migrate deploy; then
  echo "ERROR: Database migration failed!"
  echo "If this is a fresh install, ensure DATABASE_URL is correct."
  echo "If upgrading, check for pending migrations."
  exit 1
fi

echo "Starting application..."
exec "$@"
