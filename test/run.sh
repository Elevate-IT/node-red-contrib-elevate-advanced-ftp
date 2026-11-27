#!/usr/bin/env bash
# Runs test/harness.js against local FTP and explicit-FTPS servers (pyftpdlib).
# Requires: node, openssl, uv (https://docs.astral.sh/uv/) to run the Python servers.
# Uses ports 2121-2125 and 30000-30199 on 127.0.0.1.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
PIDS=()

cleanup() {
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/root" "$WORK/local"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
    -days 1 -subj "/CN=localhost" 2>/dev/null

for mode in plain tls; do
    uv run -q --no-project --with pyftpdlib --with pyopenssl \
        python -I "$HERE/ftp_server.py" "$WORK/root" "$WORK" "$mode" > "$WORK/$mode.log" 2>&1 &
    PIDS+=($!)
done

# Wait for both servers to send their greeting
for port in 2121 2122; do
    for _ in $(seq 1 60); do
        if node -e "
            const s = require('net').connect($port, '127.0.0.1');
            s.on('data', d => process.exit(/^220/.test(d.toString()) ? 0 : 1));
            s.on('error', () => process.exit(1));
            setTimeout(() => process.exit(1), 1000);" 2>/dev/null; then
            continue 2
        fi
        sleep 0.5
    done
    echo "FTP server on port $port did not start, see logs:" >&2
    cat "$WORK"/*.log >&2
    exit 1
done

node "$HERE/harness.js" "$WORK"
