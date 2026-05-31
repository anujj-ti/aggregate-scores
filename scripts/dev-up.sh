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
AWS_REGION="${AWS_REGION:-us-east-1}"
API_PORT="${API_PORT:-3000}"
WORKER_PORT="${WORKER_PORT:-8000}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:${FRONTEND_PORT:-3001}}"

eval "$(pnpm tsx scripts/emit_local_exports.ts)"

aws_local() {
  aws --endpoint-url "${AWS_ENDPOINT_URL}" --region "${AWS_REGION}" "$@"
}

echo "Starting local services from docker-compose..."
docker compose up -d

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

queue_work_url="$(aws_local sqs get-queue-url --queue-name "${QUEUE_WORK}" --query 'QueueUrl' --output text)"
queue_dlq_url="$(aws_local sqs get-queue-url --queue-name "${QUEUE_DLQ}" --query 'QueueUrl' --output text)"

echo
echo "Local development environment is ready."
echo
echo "Links:"
echo "- Frontend (planned): ${FRONTEND_URL}"
echo "- API (planned): http://localhost:${API_PORT}"
echo "- Worker (planned): http://localhost:${WORKER_PORT}"
echo "- LocalStack health: ${AWS_ENDPOINT_URL}/_localstack/health"
echo
echo "Local resources:"
echo "- S3 bucket: s3://${S3_BUCKET_NAME}"
echo "- SQS work queue: ${queue_work_url}"
echo "- SQS DLQ: ${queue_dlq_url}"
echo "- DynamoDB tables: ${DDB_TABLE_JOBS}, ${DDB_TABLE_READY}, ${DDB_TABLE_TASKS}, ${DDB_TABLE_FLEET}"
echo

open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "${FRONTEND_URL}" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${FRONTEND_URL}" >/dev/null 2>&1 || true
  elif command -v start >/dev/null 2>&1; then
    start "${FRONTEND_URL}" >/dev/null 2>&1 || true
  else
    return
  fi
}

echo "Opening frontend URL in browser (service may not exist yet)..."
open_browser
