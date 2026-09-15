#!/usr/bin/env bash
# Stop any running local transcription batch and start a fresh one in the
# background. Safe to re-run: interrupted episodes are reset to 'fail' on
# startup (see db.js) and picked up again, with no duplicate segments.
#
# Usage:
#   scripts/restart-transcribe.sh                 # all channels with failed videos
#   scripts/restart-transcribe.sh <channel_id>     # just one channel
set -euo pipefail

CHANNEL_ID="${1:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$ROOT_DIR/data/transcribe.log"
PID_FILE="$ROOT_DIR/data/transcribe.pid"

mkdir -p "$ROOT_DIR/data"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing run (pid $OLD_PID)…"
    pkill -TERM -P "$OLD_PID" 2>/dev/null || true
    kill -TERM "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

echo "=== restart $(date) channel=${CHANNEL_ID:-<all>} ===" >> "$LOG_FILE"
nohup node "$ROOT_DIR/scripts/transcribe-podcast.mjs" "$CHANNEL_ID" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
disown
echo "$NEW_PID" > "$PID_FILE"

echo "Started (pid $NEW_PID)."
echo "Log:  $LOG_FILE"
echo "Follow with: tail -f $LOG_FILE"
