"""Model bake-off: run Ticket Resolver on issue #1 up to the evidence card, per candidate model.

Usage: python3 scripts/bakeoff.py [model ...]
(model names as configured in TrueForge's `openrouter` provider)
Writes runs/bakeoff/<UTC_TS>.json.

No GitHub write tools are enabled, so nothing on GitHub changes. Measures whether the model
reproduces (3/3 fail), fixes (3/3 pass + full suite green), shows the evidence card and ends
with a handoff block, plus steps, tokens, wall time and estimated cost.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

REPO = subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
).stdout.strip()
API = os.environ.get("TRUEFORGE_URL", "http://localhost:8790").rstrip("/") + "/api/v1"
TIMEOUT_S = 15 * 60

OR_IDS = {
    "deepseek-v4-flash-0731": "deepseek/deepseek-v4-flash-0731",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "glm-5-3-flash": "z-ai/glm-5.3-flash",
    "gpt-5-nano": "openai/gpt-5-nano",
    "gpt-oss-20b": "openai/gpt-oss-20b",
}

# Vendor-recommended agentic settings, same for every model
# (docs/reference/deepseek-v4-and-glm-5.3-prompting.md).
PARAMS = {"reasoning_effort": "high", "temperature": 1.0, "top_p": 0.95, "max_tokens": 32768}

EVAL = """
<evaluation_mode>
This run is a capability test. GitHub write tools are NOT available: do not create branches,
push, open PRs or comment. Do every step of the procedure up to and including the evidence check
and the evidence card (pinned SHA, reproduce 3x, patch, rerun 3x, full suite, self-review). Then
stop and end with the handoff JSON: status "noop", outcome "fixed" if all five evidence checks
passed, otherwise "could_not_fix".
</evaluation_mode>
"""


def req(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        API + path, data=data, method=method, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw) if raw.strip().startswith(b"{") else raw


def pricing():
    with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=60) as resp:
        d = {m["id"]: m["pricing"] for m in json.load(resp)["data"]}
    out = {}
    for name, mid in OR_IDS.items():
        p = d[mid]
        out[name] = tuple(float(p.get(k) or 0) for k in ("prompt", "completion", "input_cache_read"))
    return out


def spec(model):
    with open(f"{REPO}/agents/ticket-resolver.json") as fh:
        agent = json.load(fh)["manifest"]
    with open(f"{REPO}/skills/ticket-resolver/SKILL.md") as fh:
        skill = fh.read()
    return {
        "model": {"name": f"openrouter/{model}", "params": PARAMS},
        "instructions": agent["instructions"]
        + '\n\n<skill name="ticket-resolver">\n'
        + skill
        + "\n</skill>\n"
        + EVAL,
        "mcp_servers": [
            {
                "name": "github",
                "enable_tools": ["issue_read", "list_commits", "list_pull_requests", "get_file_contents"],
            }
        ],
        "config": {
            "iteration_limit": 60,
            "sandbox": {"enabled": True},
            "dynamic_sub_agents": {"enabled": False},
            "ask_user_questions": {"enabled": False},
        },
    }


def all_events(sid):
    items, token = [], None
    while True:
        q = f"/sessions/{sid}/events?limit=100" + (f"&page_token={token}" if token else "")
        d = req("GET", q)
        items += d["data"]
        token = (d.get("pagination") or {}).get("next_page_token")
        if not token:
            return list(reversed(items))


def analyse(model, sid, tid, started, prices):
    turn = req("GET", f"/sessions/{sid}/turns/{tid}")["data"]
    state = turn["state"]
    events = [x["event"] for x in all_events(sid)]
    # Pair each call with the next response carrying its id, in event order: some OpenRouter hosts reuse ids
    # (call_0, call_1, ...) across turns, so a dict keyed by id would drop calls.
    pending, pairs = [], []
    for e in events:
        if e["type"] == "model.message":
            pending += [(c["id"], c["function"]) for c in e.get("tool_calls") or []]
        if e["type"] == "tool.response":
            for i, (cid, fn) in enumerate(pending):
                if cid == e["tool_call_id"]:
                    pairs.append((fn, e.get("content", "")))
                    del pending[i]
                    break
    pairs += [(fn, "{}") for _cid, fn in pending]
    calls = [fn for fn, _ in pairs]
    execs = []
    for fn, content in pairs:
        if fn["name"] != "exec":
            continue
        try:
            cmd = json.loads(fn["arguments"]).get("command", "")
        except Exception:
            cmd = ""
        try:
            resp = json.loads(content or "{}").get("response", {})
        except Exception:
            resp = {}
        execs.append((cmd, resp.get("exitCode"), str(resp.get("result", ""))[-4000:]))
    issue_runs = [(code, out) for cmd, code, out in execs if "test_issue_1" in cmd and "pytest" in cmd]
    fail_before = any(re.search(r"\d+ failed", out) for _code, out in issue_runs)
    pass_after = any(
        code == 0 and re.search(r"\d+ passed", out) and "failed" not in out for code, out in issue_runs
    )
    suite = [
        (code, out)
        for cmd, code, out in execs
        if "pytest" in cmd and "test_issue_1" not in cmd and re.search(r"(\d{3}) passed", out)
    ]
    suite_green = any(code == 0 and "failed" not in out for code, out in suite)
    msgs = [e.get("content") or "" for e in events if e["type"] == "model.message"]
    final = (state.get("output") or {}).get("content") or ""
    m = state.get("metrics") or {}
    tin, tout, tcache = (
        m.get("total_input_tokens", 0),
        m.get("total_output_tokens", 0),
        m.get("total_cache_read_tokens", 0),
    )
    pin, pout, pcache = prices[model]
    cost = (tin - tcache) * pin + tcache * pcache + tout * pout
    return {
        "model": model,
        "session_id": sid,
        "status": state.get("status"),
        "error": state.get("error"),
        "wall_s": round(time.time() - started),
        "model_messages": len(msgs),
        "exec_calls": len(execs),
        "tool_calls": len(calls),
        "repro_fail_before": bool(fail_before),
        "issue_test_pass_after": bool(pass_after),
        "full_suite_green": bool(suite_green),
        "evidence_card": any("EVIDENCE" in t for t in msgs + [final]),
        "handoff_block": "```json" in final,
        "tokens": {"in": tin, "out": tout, "cache_read": tcache},
        "cost_usd": round(cost, 4),
        "final_tail": final[-700:],
    }


def run(model, prices, results):
    started = time.time()
    try:
        sid = req("POST", "/sessions", {"agent": {"spec": spec(model)}, "metadata": {"bakeoff": model}})[
            "data"
        ]["id"]
        today = time.strftime("%Y-%m-%d")
        kickoff = (
            f"Resolve GitHub issue #1 in vishnuverse/humanize. Today is {today}. "
            "Evaluation mode (see <evaluation_mode>)."
        )
        tid = req(
            "POST",
            f"/sessions/{sid}/turns",
            {"input": [{"type": "user.message", "content": kickoff}], "stream": False},
        )["data"]["id"]
        print(f"[{model}] session {sid} turn {tid} started", flush=True)
        try:
            req("GET", f"/sessions/{sid}/turns/{tid}/subscribe", timeout=TIMEOUT_S)
        except Exception as exc:  # stream may end abruptly; state is read below
            print(f"[{model}] subscribe ended: {exc}", flush=True)
        for _ in range(60):
            if req("GET", f"/sessions/{sid}/turns/{tid}")["data"]["state"]["status"] != "running":
                break
            if time.time() - started > TIMEOUT_S:
                req("POST", f"/sessions/{sid}/cancel", {})
                break
            time.sleep(10)
        results[model] = analyse(model, sid, tid, started, prices)
    except Exception as exc:
        results[model] = {
            "model": model,
            "status": "harness_error",
            "error": repr(exc),
            "wall_s": round(time.time() - started),
        }
    print(f"[{model}] done: {results[model].get('status')} in {results[model].get('wall_s')}s", flush=True)


if __name__ == "__main__":
    models = sys.argv[1:] or list(OR_IDS)
    prices = pricing()
    results = {}
    threads = [threading.Thread(target=run, args=(m, prices, results)) for m in models]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    out = os.path.join(REPO, "runs", "bakeoff", time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + ".json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(results, fh, indent=1)
    print("results:", out)
    cols = [
        "status",
        "wall_s",
        "model_messages",
        "exec_calls",
        "repro_fail_before",
        "issue_test_pass_after",
        "full_suite_green",
        "evidence_card",
        "handoff_block",
        "cost_usd",
    ]
    print("\n" + "model".ljust(18) + " ".join(c[:14].rjust(14) for c in cols))
    for m in models:
        r = results[m]
        print(m.ljust(18) + " ".join(str(r.get(c, "-"))[:14].rjust(14) for c in cols))
