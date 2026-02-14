#!/bin/bash
# Scripted demo recording for ApiTap
# Uses asciinema + simulated typing for clean output
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(dirname "$SCRIPT_DIR")"
CAST_FILE="$SCRIPT_DIR/demo.cast"

# Function to simulate typing
type_cmd() {
  local cmd="$1"
  local delay="${2:-0.04}"
  for (( i=0; i<${#cmd}; i++ )); do
    printf '%s' "${cmd:$i:1}"
    sleep "$delay"
  done
  echo ""
}

# Record with asciinema
asciinema rec "$CAST_FILE" --overwrite --cols 90 --rows 24 -c bash -c '
  export PS1="$ "
  clear

  # Step 1: Show version
  sleep 0.5
  echo "$ apitap --version"
  apitap --version
  sleep 1

  # Step 2: Capture Polymarket
  echo ""
  echo "$ apitap capture polymarket.com --duration 15"
  apitap capture polymarket.com --duration 15 2>&1
  sleep 1

  # Step 3: Show captured endpoints
  echo ""
  echo "$ apitap show gamma-api.polymarket.com"
  apitap show gamma-api.polymarket.com 2>&1
  sleep 1.5

  # Step 4: Replay — the magic
  echo ""
  echo "$ apitap replay gamma-api.polymarket.com get-events"
  apitap replay gamma-api.polymarket.com get-events 2>&1 | head -20
  sleep 2

  echo ""
  echo "# No browser. No scraping. Just the API."
  sleep 2
'

echo "Recording saved to: $CAST_FILE"
echo "Upload: asciinema upload $CAST_FILE"
echo "Or convert: pip install agg && agg $CAST_FILE demo.gif"
