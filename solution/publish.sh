#!/bin/bash
# Reference solution entrypoint for the Firmware Release Publisher task.
#
# Grading model:
#   * With the candidate slot (environment/publisher/) EMPTY, tests/test.sh must
#     score reward 0 (no publisher -> `npm run report` fails -> golden diff fails).
#   * With this script run first, the reference publisher is installed into the
#     candidate slot and the same tests/test.sh must score reward 1.
#
# This script ONLY installs the authored reference publisher into /app/publisher/.
# It does NOT run `npm run report`: the distribution gateway is not running at
# install time, and starting the gateway + running the report + grading is the
# responsibility of the verifier (tests/test.sh).
set -euo pipefail

# Resolve the app root: this file lives at <root>/solution/publish.sh in the
# authoring tree; inside the built container the environment/ contents are laid
# down at /app. Support both so the script works in either place.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "/app" ] && [ -f "/app/package.json" ]; then
  APP_ROOT="/app"
else
  # Authoring sandbox: the app lives at <root>/environment.
  APP_ROOT="$(cd "${SCRIPT_DIR}/../environment" && pwd)"
fi

REFERENCE_PUBLISHER="${SCRIPT_DIR}/release-publisher.mjs"
TARGET="${APP_ROOT}/publisher/release-publisher.mjs"

echo "release-publisher(solution): installing reference publisher -> ${TARGET}"
mkdir -p "${APP_ROOT}/publisher"
cp "${REFERENCE_PUBLISHER}" "${TARGET}"
echo "release-publisher(solution): install complete; the verifier runs 'npm run report'"
