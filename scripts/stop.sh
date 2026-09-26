#!/usr/bin/env bash
# Stop what scripts/setup.sh started (pid files in runs/pids), and nothing else. Works with macOS bash 3.2.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="${SHIPGATE_PID_DIR:-$ROOT/runs/pids}"
stopped=0
for f in "$PID_DIR"/trueforge.pid "$PID_DIR"/triage.pid; do
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    *trueforge* | *mcp/triage/server.py*) kill "$pid" && echo "stopped $(basename "$f" .pid) (pid $pid)" && stopped=1 ;;
    *) echo "$(basename "$f" .pid): pid $pid is not ours any more; left alone" ;;
  esac
  rm -f "$f"
done
[ $stopped = 1 ] || echo "nothing to stop"
