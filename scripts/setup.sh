#!/usr/bin/env bash
# One-command setup for Ticket Resolver on the repo named in shipgate.yaml
# (docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §4).
#
#   scripts/setup.sh                 preflight, install, start services, register in TrueForge, check the repo, doctor
#   scripts/setup.sh --dry-run       print the plan: no network, no writes, no keys sent, nothing started
#   scripts/setup.sh --check         doctor only (services must be running)
#   options: --no-start --rotate-keys --allow-remote --allow-unprotected --smoke <issue>
# Exit 0 ok, 1 a step failed, 2 usage/config error. Never prints key values. Works with macOS bash 3.2.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

DRY=0 CHECK=0 NOSTART=0 ROTATE=0 REMOTE=0 UNPROT=0 SMOKE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --check) CHECK=1 ;;
    --no-start) NOSTART=1 ;;
    --rotate-keys) ROTATE=1 ;;
    --allow-remote) REMOTE=1 ;;
    --allow-unprotected) UNPROT=1 ;;
    --smoke)
      shift
      case "$1" in '' | *[!0-9]*) echo "setup.sh: --smoke needs an issue number" >&2; exit 2 ;; esac
      SMOKE="$1"
      ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "setup.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="${SHIPGATE_ENV_FILE:-$ROOT/.env}"
PID_DIR="${SHIPGATE_PID_DIR:-$ROOT/runs/pids}"
LOG_DIR="$ROOT/runs/logs"
ok() { printf '✓ %s\n' "$1"; }
plan() { printf '• would %s\n' "$1"; }
die() { printf '✗ %s\n' "$1" >&2; exit "${2:-1}"; }

# Value of KEY in the env file: accepts `export KEY=v`, "v" and 'v'; prints nothing else.
env_value() {
  local v
  v="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$ENV_FILE" 2>/dev/null | tail -1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
cfg() {
  local offline=""
  [ "$DRY" = 1 ] && offline="--offline"
  uv run $offline --quiet python scripts/shipgate_config.py "$1"
}
# GitHub REST with the token on stdin (never on the command line).
gh_api() {
  local method="$1" path="$2"
  shift 2
  printf 'Authorization: Bearer %s\n' "$GITHUB_PAT_VALUE" |
    curl -sS -m 20 -X "$method" -H @- -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' "https://api.github.com$path" "$@"
}
answers() { [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1")" != "000" ]; }
# The program listening on a port (empty if free), so a busy port is named instead of timing out.
port_owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1; }
url_port() { printf '%s' "$1" | sed -n 's|^https\{0,1\}://[^:/]*:\([0-9]*\).*|\1|p'; }
wait_for() {
  local url="$1" name="$2" i=0
  while [ $i -lt 90 ]; do answers "$url" && return 0; sleep 1; i=$((i + 1)); done
  printf '✗ %s did not answer within 90 s; last lines of %s:\n' "$name" "$LOG_DIR/$name.log" >&2
  tail -20 "$LOG_DIR/$name.log" >&2
  exit 1
}
start_bg() {
  local name="$1"
  shift
  mkdir -p "$PID_DIR" "$LOG_DIR"
  nohup "$@" >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$PID_DIR/$name.pid"
}
json_has() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(eval(process.argv[1])(JSON.parse(s))?0:1)}catch{process.exit(1)}})' "$1"; }

# 1. Preflight
for tool in node uv git curl; do command -v "$tool" >/dev/null 2>&1 || die "$tool not found; install it first (README)" 1; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=14)?0:1)' ||
  die "Node >= 22.14 required (have $(node -v))" 1
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing: cp .env.example .env and fill it" 2
for key in GITHUB_PAT OPENROUTER_API_KEY TYPESAFE_API_KEY; do
  [ -n "$(env_value "$key")" ] || die "$ENV_FILE: $key is empty" 2
done
ok ".env has GITHUB_PAT, OPENROUTER_API_KEY, TYPESAFE_API_KEY (values not shown)"
TARGET="$(cfg target.repo)" || exit 2
BRANCH="$(cfg target.default_branch)" || exit 2
TF_URL="${TRUEFORGE_URL:-$(cfg trueforge.url)}" || exit 2
TF_URL="${TF_URL%/}"
ok "shipgate.yaml: target $TARGET (default branch $BRANCH), TrueForge $TF_URL"
LABELS="bug:d73a4a triaged:fbca04 fix-proposed:0e8a16 cannot-reproduce:cfd3d7 needs-human:b60205"

if [ "$DRY" = 1 ]; then
  plan "install dependencies: uv sync; npm --prefix orchestrator ci"
  [ "$NOSTART" = 1 ] || plan "start TrueForge 0.2.1 at $TF_URL (20-min turns, loopback allow-list) and the triage MCP on 127.0.0.1:8803, unless already running"
  plan "register in TrueForge: model provider openrouter, connectors github and triage (keys from .env, sent only to a local TrueForge$([ "$ROTATE" = 1 ] && echo ', rotated')), then the ticket-resolver agent rendered from shipgate.yaml"
  plan "require branch protection on $TARGET@$BRANCH$([ "$UNPROT" = 1 ] && echo ' (override given)')"
  plan "create missing labels on $TARGET: $(printf '%s ' $LABELS | sed 's/:[0-9a-f]*//g')"
  plan "run the doctor$([ -n "$SMOKE" ] && echo " and a triage smoke call on #$SMOKE")"
  exit 0
fi

GITHUB_PAT_VALUE="$(env_value GITHUB_PAT)"
code="$(gh_api GET "/repos/$TARGET" -o /dev/null -w '%{http_code}')"
[ "$code" = 200 ] || die "the GitHub token cannot read $TARGET (HTTP $code)" 1
ok "GitHub token reads $TARGET"

if [ "$CHECK" = 0 ]; then
  # 2. Install
  uv sync --quiet || die "uv sync failed" 1
  npm --prefix orchestrator ci --silent >/dev/null || die "npm ci failed" 1
  ok "dependencies installed"

  # 3. Services
  if [ "$NOSTART" = 0 ]; then
    if answers "$TF_URL/"; then
      ok "TrueForge already running at $TF_URL (not restarted; it must run with OUTBOUND_URL_ALLOWED_HOSTS='[\"127.0.0.1\"]')"
    else
      tf_port="$(url_port "$TF_URL")"
      owner="$(port_owner "${tf_port:-80}")"
      [ -z "$owner" ] || die "port ${tf_port:-80} is used by '$owner' but TrueForge does not answer at $TF_URL" 1
      start_bg trueforge env SERVER_EXECUTION_TIMEOUT_SECONDS=1200 'OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]' \
        npx --yes @truefoundry/trueforge@0.2.1
      wait_for "$TF_URL/" trueforge
      ok "TrueForge started (log runs/logs/trueforge.log)"
    fi
    if answers "http://127.0.0.1:8803/mcp"; then
      ok "triage MCP already running on 127.0.0.1:8803"
    else
      owner="$(port_owner 8803)"
      [ -z "$owner" ] || die "port 8803 is used by '$owner' but the triage MCP does not answer" 1
      start_bg triage uv run mcp/triage/server.py
      wait_for "http://127.0.0.1:8803/mcp" triage
      ok "triage MCP started (log runs/logs/triage.log)"
    fi
  fi

  # 4. Register
  args=""
  [ "$ROTATE" = 1 ] && args="$args --rotate-keys"
  [ "$REMOTE" = 1 ] && args="$args --allow-remote"
  TRUEFORGE_URL="$TF_URL" SHIPGATE_ENV_FILE="$ENV_FILE" npx --yes tsx scripts/setup_trueforge.ts $args || exit 1
  TRUEFORGE_URL="$TF_URL" npx --yes tsx scripts/setup_agents.ts --inline-skill || die "agent registration failed" 1
fi

# 5. Target repo: branch protection (read), labels (only write)
protected=0
gh_api GET "/repos/$TARGET/rules/branches/$BRANCH" | json_has 'r=>Array.isArray(r)&&r.some(x=>x.type==="pull_request")' && protected=1
[ $protected = 1 ] || { gh_api GET "/repos/$TARGET/branches/$BRANCH" | json_has 'b=>b.protected===true' && protected=1; }
if [ $protected = 1 ]; then
  ok "$TARGET@$BRANCH is protected"
elif [ "$UNPROT" = 1 ]; then
  printf '! %s@%s is NOT protected: create_branch/push_files are ungated, so nothing stops a push to it\n' "$TARGET" "$BRANCH" >&2
else
  die "$TARGET@$BRANCH is not protected; add a ruleset requiring pull requests (no bypass), or pass --allow-unprotected" 1
fi
if [ "$CHECK" = 0 ]; then
  missing=""
  for pair in $LABELS; do
    name="${pair%%:*}"
    [ "$(gh_api GET "/repos/$TARGET/labels/$name" -o /dev/null -w '%{http_code}')" = 200 ] || missing="$missing $pair"
  done
  if [ -n "$missing" ]; then
    echo "creating labels on $TARGET:$(printf ' %s' $missing | sed 's/:[0-9a-f]*//g')"
    for pair in $missing; do
      code="$(gh_api POST "/repos/$TARGET/labels" -o /dev/null -w '%{http_code}' \
        -d "{\"name\":\"${pair%%:*}\",\"color\":\"${pair##*:}\"}")"
      [ "$code" = 201 ] || die "creating label ${pair%%:*} failed (HTTP $code)" 1
    done
  fi
  ok "labels present on $TARGET"
fi

# 6. Doctor
answers "http://127.0.0.1:8803/mcp" || die "triage MCP not answering on 127.0.0.1:8803 (uv run mcp/triage/server.py)" 1
TRUEFORGE_URL="$TF_URL" npx --yes tsx scripts/setup_trueforge.ts --check || die "doctor found problems (above)" 1
if [ -n "$SMOKE" ]; then
  uv run mcp/triage/server.py --smoke "$SMOKE" || die "triage smoke call failed (above)" 1
fi
ok "ready. Next: npm --prefix orchestrator run shipgate -- run --issue <n> --approve terminal"
