#!/usr/bin/env bash

set -euo pipefail

echo "Stopping LocalStack and removing local volumes..."
docker compose down -v
echo "Local development environment is down."
