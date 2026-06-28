#!/bin/sh
set -e
if [ ! -f /app/rfids.json ]; then
  cp /app/apps/backend/rfids.json.example /app/rfids.json
  echo "Seeded /app/rfids.json from example."
fi
exec node apps/backend/dist/main.js
