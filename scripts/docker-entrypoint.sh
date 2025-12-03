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
npx prisma migrate deploy

echo "Starting application..."
exec "$@"
