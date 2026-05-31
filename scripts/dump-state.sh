#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <jobId>" >&2
  exit 1
fi

JOB_ID="$1"

if [[ -f ".env" ]]; then
  # shellcheck disable=SC1091
  source ".env"
elif [[ -f ".env.example" ]]; then
  # shellcheck disable=SC1091
  source ".env.example"
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"

eval "$(pnpm tsx scripts/emit_local_exports.ts)"

aws_local() {
  aws --endpoint-url "${AWS_ENDPOINT_URL}" --region "${AWS_REGION}" "$@"
}

echo "=== Jobs item (${DDB_TABLE_JOBS}) ==="
aws_local dynamodb get-item \
  --table-name "${DDB_TABLE_JOBS}" \
  --key "{\"jobId\":{\"S\":\"${JOB_ID}\"}}" \
  --output json
echo

echo "=== Ready items (${DDB_TABLE_READY}) ==="
aws_local dynamodb query \
  --table-name "${DDB_TABLE_READY}" \
  --key-condition-expression "jobId = :jobId" \
  --expression-attribute-values "{\":jobId\":{\"S\":\"${JOB_ID}\"}}" \
  --output json
echo

echo "=== Tasks items (${DDB_TABLE_TASKS}) ==="
aws_local dynamodb query \
  --table-name "${DDB_TABLE_TASKS}" \
  --key-condition-expression "jobId = :jobId" \
  --expression-attribute-values "{\":jobId\":{\"S\":\"${JOB_ID}\"}}" \
  --output json
echo

echo "=== S3 objects (jobs/${JOB_ID}/) ==="
aws_local s3 ls "s3://${S3_BUCKET_NAME}/jobs/${JOB_ID}/" --recursive || true
