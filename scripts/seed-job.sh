#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <F> <C>" >&2
  exit 1
fi

if [[ -f ".env" ]]; then
  # shellcheck disable=SC1091
  source ".env"
elif [[ -f ".env.example" ]]; then
  # shellcheck disable=SC1091
  source ".env.example"
fi

API_PORT="${API_PORT:-3000}"

curl -sS -X POST "http://localhost:${API_PORT}/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"F\": $1, \"C\": $2}"
echo
