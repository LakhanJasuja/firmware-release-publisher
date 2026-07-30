#!/bin/bash
# Verifier entrypoint for the Firmware Release Publisher task.
#
# Responsibilities:
#   1. Reset prior run state (releases.duckdb, gateway ledger).
#   2. Start the provided Express distribution gateway in the background on 7070,
#      pointed at the current signing certificate, and wait for readiness.
#   3. Run the pytest suite, which drives `npm run report` and inspects the
#      resulting output / DuckDB state / gateway behaviour.
#   4. Write a binary 0/1 reward to ${LOG_DIR}/reward.txt.
#
# environment_mode = shared: pytest + duckdb + requests are pre-installed in the
# verifier image; the gateway's node deps are installed at build time. No network
# is used at run time.

if [ "$PWD" = "/" ]; then
    echo "Error: No working directory set. Please set a WORKDIR in your Dockerfile before running this script."
    exit 1
fi

# Log/reward destination. Defaults to the in-container path; overridable via
# LOG_DIR so the verifier can also be exercised in a local sandbox.
LOG_DIR="${LOG_DIR:-/logs/verifier}"
mkdir -p "${LOG_DIR}"

# --- locate the app ----------------------------------------------------------
# In the built container the environment/ contents are laid down at /app. In the
# authoring sandbox they live under ./environment relative to the repo root.
if [ -d "/app" ] && [ -f "/app/package.json" ]; then
  APP_ROOT="/app"
else
  APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../environment" && pwd)"
fi
export APP_ROOT

GATEWAY_DIR="${APP_ROOT}/distribution-gateway"

# The gateway verifies against the CURRENT certificate. Inside the container it is
# at the build-time path; allow an override so the verifier also runs in a local
# sandbox that mints its own keys.
export CURRENT_CERT_PATH="${CURRENT_CERT_PATH:-/app/keys/current/current.cert.pem}"
export CURRENT_KEY_PATH="${CURRENT_KEY_PATH:-/app/keys/current/current.key.pem}"
export GATEWAY_DATA_DIR="${GATEWAY_DATA_DIR:-${GATEWAY_DIR}/data}"
export GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://127.0.0.1:7070}"

# --- reset prior state -------------------------------------------------------
rm -f "${APP_ROOT}/releases.duckdb" "${APP_ROOT}/releases.duckdb.wal"
rm -f "${GATEWAY_DATA_DIR}"/*.json 2>/dev/null || true

# --- start the gateway in the background -------------------------------------
( cd "${GATEWAY_DIR}" && PORT=7070 node server.js >${LOG_DIR}/gateway.log 2>&1 ) &
GATEWAY_PID=$!

cleanup() {
  kill "${GATEWAY_PID}" 2>/dev/null || true
  wait "${GATEWAY_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for readiness (up to ~20s). Probe with whatever is available: curl if
# present, otherwise Node's built-in fetch (Node >=18 is guaranteed here), so the
# check does not depend on curl being installed in the base image.
probe_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf "${GATEWAY_BASE_URL}/healthz" >/dev/null 2>&1
  else
    node -e "fetch('${GATEWAY_BASE_URL}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
  fi
}
ready=0
for _ in $(seq 1 100); do
  if probe_health; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "${ready}" -ne 1 ]; then
  echo "Error: distribution-gateway did not become ready on 7070"
  cat ${LOG_DIR}/gateway.log 2>/dev/null || true
  echo 0 > ${LOG_DIR}/reward.txt
  exit 2
fi

# --- run the graded suite ----------------------------------------------------
# Test file location: /tests inside the container; overridable for local runs.
TEST_FILE="${TEST_FILE:-/tests/test_outputs.py}"
# Prefer python3 (installed by the Dockerfile); fall back to python if that is
# what the verifier image provides.
if [ -z "${PYTHON:-}" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
  else
    PYTHON="python"
  fi
fi
# -p no:cacheprovider: /tests may be mounted read-only, so don't try to write
# a .pytest_cache there.
"${PYTHON}" -m pytest -p no:cacheprovider --ctrf ${LOG_DIR}/ctrf.json "${TEST_FILE}" -rA
code=$?

echo "pytest exit code: ${code}"

if [ "$code" -eq 0 ]; then
  echo 1 > ${LOG_DIR}/reward.txt
else
  echo 0 > ${LOG_DIR}/reward.txt
fi
