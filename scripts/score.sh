#!/usr/bin/env bash
# Score one scenario end to end, or all of them (SPEC §4.7):
#
#   scripts/score.sh TR-01   # reset.sh --yes (if the scenario says reset: true) -> orchestrator in script mode
#                            #   -> check.py TR-01; exits with check.py's code
#   scripts/score.sh --all   # every scenario in run order (TR-09 right after TR-01), then check.py --all
#
# The orchestrator's exit code (0 ok, 1 error, 2 timeout, 3 unexpected gate, 4 no handoff) is reported,
# and check.py still runs: it grades whatever the run left behind. Works with macOS bash 3.2.
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

orchestrator_meaning() {
  case "$1" in
    0) echo "finished, handoff parsed" ;;
    1) echo "error" ;;
    2) echo "timeout" ;;
    3) echo "unexpected gate in script mode" ;;
    4) echo "finished without a valid handoff block" ;;
    *) echo "unknown" ;;
  esac
}

# run_scenario ID ISSUE RESET TIMEOUT: reset -> orchestrator -> check.py; returns check.py's exit code.
run_scenario() {
  local id="$1" issue="$2" reset="$3" timeout="$4" code
  echo "=== $id: issue #$issue, reset $reset, timeout ${timeout} min"
  if [ "$reset" = "true" ]; then
    if ! bash scripts/reset.sh --yes; then
      echo "score.sh: reset failed; not running $id" >&2
      return 1
    fi
  fi
  npm --prefix orchestrator run shipgate -- run --issue "$issue" --approve script --scenario "$id" \
    --timeout-min "$timeout" < /dev/null
  code=$?
  echo "score.sh: orchestrator exit $code ($(orchestrator_meaning "$code"))"
  uv run python scripts/check.py "$id" < /dev/null
}

if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  [ $# -eq 1 ] && exit 0
  exit 2
fi

PLAN="$(uv run python scripts/check.py --plan $([ "$1" = "--all" ] || echo "$1"))" || {
  echo "score.sh: cannot read the scenario plan" >&2
  exit 2
}
if [ -z "$PLAN" ]; then
  echo "score.sh: no scenario $1" >&2
  exit 2
fi

# The agent's first step is triage_ticket; without the triage MCP every run would fail closed (patch held).
if [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8803/mcp)" = "000" ]; then
  echo "score.sh: the triage MCP is not answering on 127.0.0.1:8803; start it with: uv run mcp/triage/server.py" >&2
  exit 2
fi

if [ "$1" != "--all" ]; then
  read -r id issue reset timeout <<EOF
$PLAN
EOF
  run_scenario "$id" "$issue" "$reset" "$timeout"
  exit $?
fi

# --all: read the whole plan first so the per-scenario commands cannot eat the loop's stdin.
IDS=""
while read -r id issue reset timeout; do
  [ -z "$id" ] && continue
  IDS="$IDS $id:$issue:$reset:$timeout"
done <<EOF
$PLAN
EOF
for entry in $IDS; do
  IFS=: read -r id issue reset timeout <<EOF
$entry
EOF
  run_scenario "$id" "$issue" "$reset" "$timeout"
done
echo "=== all scenarios"
uv run python scripts/check.py --all
