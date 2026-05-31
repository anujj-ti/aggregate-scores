#!/usr/bin/env bash

set -euo pipefail

TMP_DIR=".tmp"
API_PID_FILE="${TMP_DIR}/api-dev.pid"
WORKER_PID_FILE="${TMP_DIR}/worker-dev.pid"
WEB_PID_FILE="${TMP_DIR}/web-dev.pid"

stop_process() {
  local pid_file="$1"
  local label="$2"

  if [[ ! -f "${pid_file}" ]]; then
    return
  fi

  local proc_pid
  proc_pid="$(cat "${pid_file}")"
  if ps -p "${proc_pid}" >/dev/null 2>&1; then
    echo "Stopping ${label} (pid ${proc_pid})..."
    kill "${proc_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${pid_file}"
}

stop_port_listener() {
  local port="$1"
  local pid
  pid="$(lsof -ti ":${port}" || true)"
  if [[ -n "${pid}" ]]; then
    echo "Stopping process on port ${port} (pid ${pid})..."
    kill "${pid}" >/dev/null 2>&1 || true
  fi
}

stop_port_listener 3000
stop_port_listener 3001
stop_process "${API_PID_FILE}" "API dev server"
stop_process "${WEB_PID_FILE}" "web dev server"
stop_process "${WORKER_PID_FILE}" "worker"

echo "Stopping LocalStack and removing local volumes..."
docker compose down -v
echo "Local development environment is down."
