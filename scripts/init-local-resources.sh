#!/usr/bin/env bash

set -euo pipefail

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

create_bucket() {
  if aws_local s3api head-bucket --bucket "${S3_BUCKET_NAME}" >/dev/null 2>&1; then
    echo "Bucket exists: ${S3_BUCKET_NAME}"
    return
  fi

  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws_local s3api create-bucket --bucket "${S3_BUCKET_NAME}" >/dev/null
  else
    aws_local s3api create-bucket \
      --bucket "${S3_BUCKET_NAME}" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
  echo "Created bucket: ${S3_BUCKET_NAME}"
}

create_queue_with_dlq() {
  aws_local sqs create-queue --queue-name "${QUEUE_DLQ}" >/dev/null
  local dlq_url
  dlq_url="$(aws_local sqs get-queue-url --queue-name "${QUEUE_DLQ}" --query 'QueueUrl' --output text)"
  local dlq_arn
  dlq_arn="$(aws_local sqs get-queue-attributes \
    --queue-url "${dlq_url}" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text)"

  local redrive
  redrive="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "${dlq_arn}")"
  local redrive_escaped
  redrive_escaped="$(printf '%s' "${redrive}" | sed 's/"/\\"/g')"
  local attrs
  attrs="$(printf '{"VisibilityTimeout":"120","RedrivePolicy":"%s"}' "${redrive_escaped}")"
  aws_local sqs create-queue \
    --queue-name "${QUEUE_WORK}" \
    --attributes "${attrs}" >/dev/null
  echo "Created/verified queues: ${QUEUE_WORK}, ${QUEUE_DLQ}"
}

table_exists() {
  local table_name="$1"
  aws_local dynamodb describe-table --table-name "${table_name}" >/dev/null 2>&1
}

create_jobs_table() {
  if table_exists "${DDB_TABLE_JOBS}"; then
    echo "Table exists: ${DDB_TABLE_JOBS}"
    return
  fi

  aws_local dynamodb create-table \
    --table-name "${DDB_TABLE_JOBS}" \
    --attribute-definitions \
      AttributeName=jobId,AttributeType=S \
      AttributeName=status,AttributeType=S \
      AttributeName=submittedAt,AttributeType=N \
    --key-schema AttributeName=jobId,KeyType=HASH \
    --global-secondary-indexes \
      "IndexName=status-submittedAt,KeySchema=[{AttributeName=status,KeyType=HASH},{AttributeName=submittedAt,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Created table: ${DDB_TABLE_JOBS}"
}

create_ready_table() {
  if table_exists "${DDB_TABLE_READY}"; then
    echo "Table exists: ${DDB_TABLE_READY}"
    return
  fi

  aws_local dynamodb create-table \
    --table-name "${DDB_TABLE_READY}" \
    --attribute-definitions \
      AttributeName=jobId,AttributeType=S \
      AttributeName=seq,AttributeType=N \
    --key-schema \
      AttributeName=jobId,KeyType=HASH \
      AttributeName=seq,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Created table: ${DDB_TABLE_READY}"
}

create_tasks_table() {
  if table_exists "${DDB_TABLE_TASKS}"; then
    echo "Table exists: ${DDB_TABLE_TASKS}"
    return
  fi

  aws_local dynamodb create-table \
    --table-name "${DDB_TABLE_TASKS}" \
    --attribute-definitions \
      AttributeName=jobId,AttributeType=S \
      AttributeName=taskId,AttributeType=S \
    --key-schema \
      AttributeName=jobId,KeyType=HASH \
      AttributeName=taskId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Created table: ${DDB_TABLE_TASKS}"
}

create_fleet_table() {
  if table_exists "${DDB_TABLE_FLEET}"; then
    echo "Table exists: ${DDB_TABLE_FLEET}"
    return
  fi

  aws_local dynamodb create-table \
    --table-name "${DDB_TABLE_FLEET}" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Created table: ${DDB_TABLE_FLEET}"
}

seed_fleet_item() {
  aws_local dynamodb put-item \
    --table-name "${DDB_TABLE_FLEET}" \
    --item "$(cat <<EOF
{
  "pk": {"S": "${FLEET_PK}"},
  "inFlight": {"N": "0"},
  "W": {"N": "${DEFAULT_W}"}
}
EOF
)" >/dev/null
  echo "Seeded fleet item in ${DDB_TABLE_FLEET}: pk=${FLEET_PK}, W=${DEFAULT_W}"
}

create_bucket
create_queue_with_dlq
create_jobs_table
create_ready_table
create_tasks_table
create_fleet_table
seed_fleet_item

echo "Local resources initialized."
