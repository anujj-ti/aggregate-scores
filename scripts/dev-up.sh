#!/usr/bin/env bash

set -euo pipefail

if [[ -f ".env" ]]; then
  # shellcheck disable=SC1091
  source ".env"
elif [[ -f ".env.example" ]]; then
  # shellcheck disable=SC1091
  source ".env.example"
fi

AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"

echo "Starting LocalStack..."
docker compose up -d localstack

echo "Waiting for LocalStack health endpoint..."
for _ in {1..60}; do
  if curl -fsS "${AWS_ENDPOINT_URL}/_localstack/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${AWS_ENDPOINT_URL}/_localstack/health" >/dev/null 2>&1; then
  echo "LocalStack failed to become ready at ${AWS_ENDPOINT_URL}" >&2
  exit 1
fi

echo "Initializing local AWS resources..."
bash scripts/init-local-resources.sh

echo "Local development environment is ready."
