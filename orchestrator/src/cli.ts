// shipgate CLI (docs/contracts.md §2):
//   npm --prefix orchestrator run shipgate -- run --issue <n> [--approve ui|terminal|script] [--scenario <ID>]
//       [--agent ticket-resolver] [--timeout-min 10]
// Dev flags: --inline-spec <AgentSpec.json>  --prompt <text>  --no-labels
// Exit: 0 finished + handoff · 1 error · 2 timeout · 3 unexpected gate (script) · 4 no valid handoff.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ScriptDecider, StdioLineReader, TerminalDecider, UiDecider, type Decider, type Mode } from "./decide.ts";
import { loadDotenv, repoRoot } from "./env.ts";
import { GitHubLabels, TARGET_REPO } from "./labels.ts";
import { runOnce, type RunOptions } from "./runner.ts";
import { loadScenario, type Scenario } from "./scenario.ts";
import { TrueForgeClient, type AgentRef } from "./trueforge.ts";

const USAGE = `usage: shipgate run --issue <n> [--approve ui|terminal|script] [--scenario <ID>]
                    [--agent ticket-resolver] [--timeout-min 10]
                    [--inline-spec <AgentSpec.json>] [--prompt <text>] [--no-labels]`;

class UsageError extends Error {}

export interface CliArgs {
  issue: number | null;
  mode: Mode;
  scenario: string | null;
  agent: string;
  timeoutMin: number | null;
  inlineSpec: string | null;
  prompt: string | null;
  labels: boolean;
}

export function parseCli(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      issue: { type: "string" },
      approve: { type: "string", default: "terminal" },
      scenario: { type: "string" },
      agent: { type: "string", default: "ticket-resolver" },
      "timeout-min": { type: "string" },
      "inline-spec": { type: "string" },
      prompt: { type: "string" },
      "no-labels": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) throw new UsageError(USAGE);
  if (positionals.length !== 1 || positionals[0] !== "run") throw new UsageError(USAGE);
  const mode = values.approve as Mode;
  if (!["ui", "terminal", "script"].includes(mode)) throw new UsageError(`--approve must be ui, terminal or script`);
  if (mode === "script" && !values.scenario) throw new UsageError("--approve script requires --scenario <ID>");
  let issue: number | null = null;
  if (values.issue !== undefined) {
    issue = Number(values.issue);
    if (!Number.isInteger(issue) || issue <= 0) throw new UsageError(`--issue must be a positive integer`);
  }
  let timeoutMin: number | null = null;
  if (values["timeout-min"] !== undefined) {
    timeoutMin = Number(values["timeout-min"]);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new UsageError(`--timeout-min must be > 0`);
  }
  return {
    issue,
    mode,
    scenario: values.scenario ?? null,
    agent: values.agent as string,
    timeoutMin,
    inlineSpec: values["inline-spec"] ?? null,
    prompt: values.prompt ?? null,
    labels: !values["no-labels"],
  };
}

export function defaultPrompt(issue: number, mode: Mode, today: string = new Date().toISOString().slice(0, 10)): string {
  // The skill records this mode in each handoff approval entry. The date lives here, not in the agent's
  // instructions, so the system prompt stays byte-identical across days (prompt-cache hits).
  return `Resolve GitHub issue #${issue} in ${TARGET_REPO}. Approval mode: ${mode}. Today is ${today}.`;
}

async function main(argv: string[]): Promise<number> {
  const root = repoRoot();
  loadDotenv(root);
  const args = parseCli(argv);

  const scenariosDir = process.env.SHIPGATE_SCENARIOS_DIR
    ? resolve(process.env.SHIPGATE_SCENARIOS_DIR)
    : join(root, "tests", "scenarios");
  const scenario: Scenario | null = args.scenario ? loadScenario(scenariosDir, args.scenario) : null;
  if (scenario && args.issue !== null && scenario.issue !== null && scenario.issue !== args.issue) {
    throw new UsageError(`--issue ${args.issue} does not match scenario ${scenario.id} (issue ${scenario.issue})`);
  }
  const issue = args.issue ?? scenario?.issue ?? null;
  if (issue === null) throw new UsageError("--issue <n> is required");
  const timeoutMin = args.timeoutMin ?? scenario?.timeoutMin ?? 10;

  let agent: AgentRef;
  let agentLabel: string;
  if (args.inlineSpec) {
    const specPath = resolve(process.env.INIT_CWD ?? process.cwd(), args.inlineSpec);
    agent = { spec: JSON.parse(readFileSync(specPath, "utf8")) as unknown };
    agentLabel = `inline:${specPath}`;
  } else {
    agent = { name: args.agent };
    agentLabel = args.agent;
  }

  const trueforgeUrl = (process.env.TRUEFORGE_URL || "http://localhost:8790").replace(/\/+$/, "");
  const tf = new TrueForgeClient(trueforgeUrl);
  const labels = args.labels ? new GitHubLabels(TARGET_REPO, process.env.GITHUB_PAT ?? "") : null;

  const print = (text: string) => process.stdout.write(`${text}\n`);
  let decider: Decider;
  if (args.mode === "script") decider = new ScriptDecider((scenario as Scenario).approvals, { print });
  else if (args.mode === "ui") decider = new UiDecider((id) => tf.listTurns(id), { print });
  else decider = new TerminalDecider(new StdioLineReader());

  const interrupt = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
    print("\ninterrupt: cancelling the running turn and saving the run (Ctrl-C again to quit now)");
    interrupt.abort(new Error("interrupted"));
  });

  const opts: RunOptions = {
    issue,
    mode: args.mode,
    scenarioId: scenario?.id ?? null,
    agent,
    agentLabel,
    prompt: args.prompt ?? defaultPrompt(issue, args.mode),
    timeoutMin,
    repoRoot: root,
    trueforgeUrl,
  };
  print(
    `shipgate: ${opts.scenarioId ?? `issue-${issue}`} · ${TARGET_REPO}#${issue} · agent ${agentLabel} · ` +
      `approve=${args.mode} · timeout ${timeoutMin} min · labels ${labels ? "on" : "off"}`,
  );
  try {
    const res = await runOnce(opts, { tf, decider, labels, log: print, signal: interrupt.signal });
    if (decider instanceof ScriptDecider && decider.remaining > 0) {
      print(`note: ${decider.remaining} scripted approval(s) were not used`);
    }
    print(`${res.status} (exit ${res.exitCode}) · ${res.runDir}`);
    return res.exitCode;
  } finally {
    decider.close();
  }
}

// Run only when executed directly (tests import parseCli).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof UsageError) process.stderr.write(`${e.message}\n`);
      else process.stderr.write(`error: ${process.env.SHIPGATE_DEBUG ? (e as Error)?.stack : (e as Error)?.message ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
