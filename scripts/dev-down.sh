#!/usr/bin/env bash

set -euo pipefail

TMP_DIR=".tmp"
API_PID_FILE="${TMP_DIR}/api-dev.pid"

stop_api_dev_server() {
  local port_pid
  port_pid="$(lsof -ti :3000 || true)"
  if [[ -n "${port_pid}" ]]; then
    echo "Stopping API listener on port 3000 (pid ${port_pid})..."
    kill "${port_pid}" >/dev/null 2>&1 || true
  fi

  if [[ ! -f "${API_PID_FILE}" ]]; then
    return
  fi

  local api_pid
  api_pid="$(cat "${API_PID_FILE}")"
  if ps -p "${api_pid}" >/dev/null 2>&1; then
    echo "Stopping API dev server (pid ${api_pid})..."
    kill "${api_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${API_PID_FILE}"
}

stop_api_dev_server

echo "Stopping LocalStack and removing local volumes..."
docker compose down -v
echo "Local development environment is down."
