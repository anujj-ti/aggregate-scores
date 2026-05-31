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
TMP_DIR=".tmp"
API_PID_FILE="${TMP_DIR}/api-dev.pid"
API_LOG_FILE="${TMP_DIR}/api-dev.log"
WORKER_PID_FILE="${TMP_DIR}/worker-dev.pid"
WORKER_LOG_FILE="${TMP_DIR}/worker-dev.log"
WEB_PID_FILE="${TMP_DIR}/web-dev.pid"
WEB_LOG_FILE="${TMP_DIR}/web-dev.log"

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

mkdir -p "${TMP_DIR}"

start_api_dev_server() {
  if [[ -f "${API_PID_FILE}" ]]; then
    local existing_pid
    existing_pid="$(cat "${API_PID_FILE}")"
    if ps -p "${existing_pid}" >/dev/null 2>&1; then
      echo "API dev server already running (pid ${existing_pid})"
      return
    fi
    rm -f "${API_PID_FILE}"
  fi

  echo "Starting API dev server..."
  export AWS_REGION="${AWS_REGION}"
  export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL}"
  export AWS_ACCESS_KEY_ID="test"
  export AWS_SECRET_ACCESS_KEY="test"
  export AWS_SESSION_TOKEN="test"
  pnpm --filter @aggregate/api dev >"${API_LOG_FILE}" 2>&1 &
  local api_pid=$!
  echo "${api_pid}" >"${API_PID_FILE}"
  echo "API dev server started (pid ${api_pid}), logs: ${API_LOG_FILE}"
}

start_worker_dev_process() {
  if [[ -f "${WORKER_PID_FILE}" ]]; then
    local existing_pid
    existing_pid="$(cat "${WORKER_PID_FILE}")"
    if ps -p "${existing_pid}" >/dev/null 2>&1; then
      echo "Worker already running (pid ${existing_pid})"
      return
    fi
    rm -f "${WORKER_PID_FILE}"
  fi

  echo "Starting Python worker..."
  PYTHONPATH="apps/worker/src" \
    python -m worker >"${WORKER_LOG_FILE}" 2>&1 &
  local worker_pid=$!
  echo "${worker_pid}" >"${WORKER_PID_FILE}"
  echo "Worker started (pid ${worker_pid}), logs: ${WORKER_LOG_FILE}"
}

start_web_dev_server() {
  if [[ -f "${WEB_PID_FILE}" ]]; then
    local existing_pid
    existing_pid="$(cat "${WEB_PID_FILE}")"
    if ps -p "${existing_pid}" >/dev/null 2>&1; then
      echo "Web dev server already running (pid ${existing_pid})"
      return
    fi
    rm -f "${WEB_PID_FILE}"
  fi

  echo "Starting web dev server..."
  pnpm --filter @aggregate/web dev >"${WEB_LOG_FILE}" 2>&1 &
  local web_pid=$!
  echo "${web_pid}" >"${WEB_PID_FILE}"
  echo "Web dev server started (pid ${web_pid}), logs: ${WEB_LOG_FILE}"
}

start_api_dev_server
start_worker_dev_process
start_web_dev_server

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
echo "- API dev log: ${API_LOG_FILE}"
echo "- Worker log: ${WORKER_LOG_FILE}"
echo "- Web dev log: ${WEB_LOG_FILE}"
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

echo "Opening frontend URL in browser..."
open_browser
echo "Startup script finished. Services keep running in background. Use ./scripts/dev-down.sh to stop them."
