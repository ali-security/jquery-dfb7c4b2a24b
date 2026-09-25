#!/usr/bin/env bash
# Run the QUnit browser suite (test/index.html) in headless Chrome.
# Expects dist/jquery.js to be built already (npm test / grunt).
set -euo pipefail

PORT=8000
URL="http://127.0.0.1:${PORT}/test/index.html"
PHP_LOG=/tmp/php-server.log
RUNNER_DIR=/tmp/qunit-runner

# Serve the repo root with PHP so the ajax tests (test/data/*.php) work.
# Several workers: core/dont_return.php deliberately hangs, and a single-worker
# server would stall every request queued behind it (the next iframe tests time out).
PHP_CLI_SERVER_WORKERS=8 php -S "127.0.0.1:${PORT}" -t "$PWD" >"$PHP_LOG" 2>&1 &
PHP_PID=$!
trap 'kill "$PHP_PID" 2>/dev/null' EXIT

for i in $(seq 1 30); do
	if curl -sf -o /dev/null "$URL"; then
		break
	fi
	if [ "$i" -eq 30 ]; then
		echo "PHP server did not come up on port ${PORT}" >&2
		tail -50 "$PHP_LOG" >&2
		exit 1
	fi
	sleep 1
done
echo "PHP server is up at ${URL}"

# Modern Node for the runner only; the build keeps using node 0.10
set +u
# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh"
nvm install 18
nvm use 18
set -u
node --version

mkdir -p "$RUNNER_DIR"
npm install --prefix "$RUNNER_DIR" puppeteer-core@21 --no-audit --no-fund
export NODE_PATH="${RUNNER_DIR}/node_modules"

CHROME_BIN=""
for candidate in google-chrome-stable google-chrome chromium-browser; do
	if command -v "$candidate" >/dev/null; then
		CHROME_BIN="$(command -v "$candidate")"
		break
	fi
done
if [ -z "$CHROME_BIN" ]; then
	echo "No Chrome/Chromium binary found" >&2
	exit 1
fi
export CHROME_BIN
echo "Using Chrome: ${CHROME_BIN}"

status=0
node test/ci/run-browser-tests.js "$URL" || status=$?

if [ "$status" -ne 0 ]; then
	echo "Browser tests failed (exit ${status}); last lines of the PHP server log:"
	tail -50 "$PHP_LOG"
fi
exit "$status"
