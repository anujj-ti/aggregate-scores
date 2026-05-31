#!/usr/bin/env bash

set -euo pipefail

if docker compose config --services | awk '$0=="worker"{found=1} END{exit !found}'; then
  docker compose logs -f worker
  exit 0
fi

echo "No 'worker' service is defined in docker-compose yet."
echo "Following LocalStack logs instead; switch this script to worker logs once worker service exists."
docker compose logs -f localstack
