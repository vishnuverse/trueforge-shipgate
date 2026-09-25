#!/usr/bin/env bash
# Reset the Ticket Resolver fixtures on vishnuverse/humanize, and nothing else.
#
#   scripts/reset.sh          # dry run (default): print the plan, change nothing
#   scripts/reset.sh --yes    # apply the plan
#
# Plan: close open PRs whose head starts with fix/, delete fix/* branches, delete issue comments written by the
# token's user on #1-#7, set the labels on #1-#7 to exactly `bug`, reopen any closed fixture issue.
# Auth: GH_TOKEN=$GITHUB_PAT when GITHUB_PAT is set (env, else .env at the repo root); otherwise gh's own login.
# Works with macOS bash 3.2.
set -o pipefail

REPO="vishnuverse/humanize" # hard-coded on purpose: this script refuses to touch any other repo
ISSUES="1 2 3 4 5 6 7"
APPLY=0

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --yes) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "reset.sh: unknown argument '$arg' (the target is fixed: $REPO)" >&2
      exit 2
      ;;
  esac
done

for var in GH_REPO SHIPGATE_REPO; do
  val="${!var}"
  if [ -n "$val" ] && [ "$val" != "$REPO" ]; then
    echo "reset.sh: refusing: $var=$val, this script only resets $REPO" >&2
    exit 2
  fi
done
unset GH_REPO

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "$GITHUB_PAT" ] && [ -f "$ROOT/.env" ]; then
  GITHUB_PAT="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?GITHUB_PAT[[:space:]]*=[[:space:]]*//p' "$ROOT/.env" |
    tail -n 1 | sed -E "s/^[\"']//; s/[\"'][[:space:]]*$//")"
fi
if [ -n "$GITHUB_PAT" ]; then
  export GH_TOKEN="$GITHUB_PAT"
fi

if ! command -v gh > /dev/null 2>&1; then
  echo "reset.sh: gh CLI not found (https://cli.github.com)" >&2
  exit 1
fi

ME="$(gh api user --jq .login 2> /dev/null)"
if [ -z "$ME" ]; then
  echo "reset.sh: cannot read the GitHub user; set GITHUB_PAT or run 'gh auth login'" >&2
  exit 1
fi

CHANGES=0
FAILED=0
# step "<description>" <command...>: print the plan line, or run the command with --yes.
step() {
  local desc="$1"
  shift
  CHANGES=$((CHANGES + 1))
  if [ "$APPLY" -eq 1 ]; then
    if "$@" > /dev/null; then
      echo "  done: $desc"
    else
      echo "  FAILED: $desc" >&2
      FAILED=$((FAILED + 1))
    fi
  else
    echo "  plan: $desc"
  fi
}

if [ "$APPLY" -eq 1 ]; then
  echo "reset.sh: resetting $REPO as $ME"
else
  echo "reset.sh: DRY RUN for $REPO as $ME (nothing changes; pass --yes to apply)"
fi

# 1. Open PRs whose head branch starts with fix/.
PRS="$(gh pr list -R "$REPO" --state open --limit 500 --json number,headRefName \
  --jq '.[] | select(.headRefName | startswith("fix/")) | "\(.number) \(.headRefName)"')" || {
  echo "reset.sh: cannot list PRs on $REPO" >&2
  exit 1
}
while read -r num head; do
  [ -z "$num" ] && continue
  step "close PR #$num ($head)" gh pr close "$num" -R "$REPO"
done <<EOF
$PRS
EOF

# 2. fix/* branches.
REFS="$(gh api "repos/$REPO/git/matching-refs/heads/fix/" --paginate --jq '.[].ref')" || {
  echo "reset.sh: cannot list branches on $REPO" >&2
  exit 1
}
while read -r ref; do
  [ -z "$ref" ] && continue
  branch="${ref#refs/heads/}"
  step "delete branch $branch" gh api -X DELETE "repos/$REPO/git/$ref"
done <<EOF
$REFS
EOF

# 3-5. Fixture issues: our comments, labels, state.
for n in $ISSUES; do
  info="$(gh api "repos/$REPO/issues/$n" \
    --jq 'if .pull_request then "PR" else "\(.state)\t\([.labels[].name] | join(","))" end' 2> /dev/null)"
  if [ -z "$info" ]; then
    echo "  skip: #$n not found (fixtures not planted yet, or Issues disabled)"
    continue
  fi
  if [ "$info" = "PR" ]; then
    echo "  skip: #$n is a pull request, not a fixture issue"
    continue
  fi
  state="$(printf '%s' "$info" | cut -f1)"
  labels="$(printf '%s' "$info" | cut -f2)"

  ids="$(gh api "repos/$REPO/issues/$n/comments" --paginate \
    --jq ".[] | select(.user.login == \"$ME\") | .id")" || {
    echo "reset.sh: cannot list comments on #$n" >&2
    exit 1
  }
  for id in $ids; do
    step "delete comment $id on #$n (by $ME)" gh api -X DELETE "repos/$REPO/issues/comments/$id"
  done

  if [ "$labels" != "bug" ]; then
    step "set labels on #$n: [$labels] -> [bug]" gh api -X PUT "repos/$REPO/issues/$n/labels" -f 'labels[]=bug'
  fi

  if [ "$state" = "closed" ]; then
    step "reopen #$n" gh api -X PATCH "repos/$REPO/issues/$n" -f state=open
  fi
done

if [ "$CHANGES" -eq 0 ]; then
  echo "reset.sh: nothing to reset"
elif [ "$APPLY" -eq 1 ]; then
  echo "reset.sh: $CHANGES change(s) applied, $FAILED failed"
else
  echo "reset.sh: $CHANGES change(s) planned; run with --yes to apply"
fi
[ "$FAILED" -eq 0 ]
