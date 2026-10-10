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
#
# NOTE: --accept-data-loss is deliberately NOT passed. Additive changes (new
# tables, new nullable columns, new columns with defaults, new indexes) still
# apply automatically. Destructive changes (dropping/renaming a column or
# table, narrowing a type, adding a unique constraint over duplicate data)
# will make `prisma db push` fail here and the container will refuse to start,
# instead of silently dropping production data. Handle such changes manually
# (take a backup with scripts/backup.sh, migrate the data, then push).
echo "Syncing database schema..."
if ! npx prisma db push --url "$DATABASE_URL"; then
  echo "ERROR: Database schema sync failed!"
  echo "If this is a fresh install, ensure DATABASE_URL is correct."
  echo "If the schema change is destructive (would drop data), prisma refuses"
  echo "to apply it without --accept-data-loss. Back up and migrate manually."
  exit 1
fi

echo "Starting application..."
exec "$@"
