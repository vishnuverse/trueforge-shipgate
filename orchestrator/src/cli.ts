// shipgate CLI (docs/contracts.md §2):
//   npm --prefix orchestrator run shipgate -- run (--issue <n> | --ticket <KEY>) [--approve ui|terminal|script]
//       [--scenario <ID>] [--agent <name>] [--timeout-min N]  (default: scenario's, else 60 for ui/terminal)
// --agent defaults to ticket-resolver (--issue) or ticket-resolver-jira (--ticket, needs shipgate.yaml jira:).
// Dev flags: --inline-spec <AgentSpec.json>  --prompt <text>  --no-labels
// Exit: 0 finished + handoff · 1 error · 2 timeout or config error · 3 unexpected gate (script) · 4 no valid handoff.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ScriptDecider, StdioLineReader, TerminalDecider, UiDecider, type Decider, type Mode } from "./decide.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { loadDotenv, repoRoot } from "./env.ts";
import { GitHubLabels, JiraStatus, targetRepo, type LabelOps } from "./labels.ts";
import { runOnce, type RunOptions } from "./runner.ts";
import { loadScenario, type Scenario } from "./scenario.ts";
import { defaultAgent, jiraKickoff, parseJiraKey, requireJira, ticketRef, ticketRunId, type Ticket } from "./ticket.ts";
import { TrueForgeClient, type AgentRef } from "./trueforge.ts";

const USAGE = `usage: shipgate run (--issue <n> | --ticket <KEY>) [--approve ui|terminal|script] [--scenario <ID>]
                    [--agent <name>] [--timeout-min N]
  --issue runs a GitHub issue (agent ticket-resolver); --ticket runs a Jira ticket such as KAN-4
  (agent ticket-resolver-jira; needs the jira: section of shipgate.yaml). --agent overrides the agent.
  --timeout-min defaults to the scenario's timeout_min, else 60 (a human may deliberate at the gates)
                    [--inline-spec <AgentSpec.json>] [--prompt <text>] [--no-labels]`;

export class UsageError extends Error {}

export interface CliArgs {
  issue: number | null;
  /** Jira key as typed (checked against shipgate.yaml jira.project by resolveTarget). */
  ticket: string | null;
  mode: Mode;
  scenario: string | null;
  /** --agent, or null for the ticket source's default agent. */
  agent: string | null;
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
      ticket: { type: "string" },
      approve: { type: "string", default: "terminal" },
      scenario: { type: "string" },
      agent: { type: "string" },
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
  if (values.issue !== undefined && values.ticket !== undefined) {
    throw new UsageError("give --issue <n> (GitHub) or --ticket <KEY> (Jira), not both");
  }
  // Neither is fine only with --scenario: the scenario names its issue or ticket.
  if (values.issue === undefined && values.ticket === undefined && !values.scenario) {
    throw new UsageError("--issue <n> or --ticket <KEY> is required");
  }
  let issue: number | null = null;
  if (values.issue !== undefined) {
    issue = Number(values.issue);
    if (!Number.isInteger(issue) || issue <= 0) throw new UsageError(`--issue must be a positive integer`);
  }
  if (values.ticket !== undefined && values.ticket.trim() === "") {
    throw new UsageError("--ticket must be a Jira key such as KAN-4");
  }
  if (values.agent !== undefined && values.agent.trim() === "") throw new UsageError("--agent must not be empty");
  let timeoutMin: number | null = null;
  if (values["timeout-min"] !== undefined) {
    timeoutMin = Number(values["timeout-min"]);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new UsageError(`--timeout-min must be > 0`);
  }
  return {
    issue,
    ticket: values.ticket ?? null,
    mode,
    scenario: values.scenario ?? null,
    agent: values.agent ?? null,
    timeoutMin,
    inlineSpec: values["inline-spec"] ?? null,
    prompt: values.prompt ?? null,
    labels: !values["no-labels"],
  };
}

/** YYYY-MM-DD in the machine's local timezone (the event runs in IST; UTC can still be the day before). */
function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Minutes before the run is cancelled. The deadline keeps running while a person reads an approval card,
 *  so runs a human answers (ui / terminal) without a scenario get a generous default. */
export function resolveTimeoutMin(flag: number | null, scenario: number | null | undefined, mode: Mode): number {
  if (flag !== null) return flag;
  if (scenario !== null && scenario !== undefined) return scenario;
  return mode === "script" ? 15 : 60;
}

export function defaultPrompt(issue: number, mode: Mode, today: string = localDate(), repo: string = targetRepo()): string {
  // The skill records this mode in each handoff approval entry. The date lives here, not in the agent's
  // instructions, so the system prompt stays byte-identical across days (prompt-cache hits).
  return `Resolve GitHub issue #${issue} in ${repo}. Approval mode: ${mode}. Today is ${today}.`;
}

/** First message of the run: the GitHub prompt above, or the Jira kickoff the Jira skill parses. */
export function kickoff(ticket: Ticket, mode: Mode, today: string, config: Config): string {
  return ticket.source === "github"
    ? defaultPrompt(ticket.number, mode, today, config.repo)
    : jiraKickoff(ticket.key, config, mode, today);
}

export interface RunTarget {
  ticket: Ticket;
  /** Saved agent name: --agent, else the ticket source's default. */
  agent: string;
}

/**
 * The ticket this run works on (flag or scenario; a scenario must agree with the flag) and its agent.
 * A Jira ticket needs shipgate.yaml jira: (ConfigError, exit 2) and a key of that project (UsageError).
 */
export function resolveTarget(args: CliArgs, scenario: Scenario | null, config: Config): RunTarget {
  if (scenario) {
    const names = scenario.ticket !== null ? `ticket ${scenario.ticket}` : `issue ${scenario.issue}`;
    if (args.issue !== null && (scenario.ticket !== null || (scenario.issue !== null && scenario.issue !== args.issue))) {
      throw new UsageError(`--issue ${args.issue} does not match scenario ${scenario.id} (${names})`);
    }
    if (args.ticket !== null && (scenario.issue !== null || (scenario.ticket !== null && scenario.ticket !== args.ticket))) {
      throw new UsageError(`--ticket ${args.ticket} does not match scenario ${scenario.id} (${names})`);
    }
  }
  const key = args.ticket ?? (args.issue === null ? (scenario?.ticket ?? null) : null);
  let ticket: Ticket;
  if (key !== null) {
    const jira = requireJira(config);
    try {
      ticket = { source: "jira", key: parseJiraKey(key, jira) };
    } catch (e) {
      throw new UsageError(`--ticket: ${(e as Error).message}`);
    }
  } else {
    const issue = args.issue ?? scenario?.issue ?? null;
    if (issue === null) throw new UsageError("--issue <n> or --ticket <KEY> is required");
    ticket = { source: "github", number: issue };
  }
  return { ticket, agent: args.agent ?? defaultAgent(ticket) };
}

/** The TrueForge base URL: env TRUEFORGE_URL when set and non-empty, else shipgate.yaml trueforge.url. */
export function resolveTrueforgeUrl(envValue: string | undefined, configUrl: string): string {
  return (envValue || configUrl).replace(/\/+$/, "");
}

async function main(argv: string[]): Promise<number> {
  const root = repoRoot();
  loadDotenv(root);
  const args = parseCli(argv);
  const config = loadConfig();
  const repo = config.repo;

  const scenariosDir = process.env.SHIPGATE_SCENARIOS_DIR
    ? resolve(process.env.SHIPGATE_SCENARIOS_DIR)
    : join(root, "tests", "scenarios");
  const scenario: Scenario | null = args.scenario ? loadScenario(scenariosDir, args.scenario) : null;
  const target = resolveTarget(args, scenario, config);
  const ticket = target.ticket;
  const timeoutMin = resolveTimeoutMin(args.timeoutMin, scenario?.timeoutMin, args.mode);

  let agent: AgentRef;
  let agentLabel: string;
  if (args.inlineSpec) {
    const specPath = resolve(process.env.INIT_CWD ?? process.cwd(), args.inlineSpec);
    agent = { spec: JSON.parse(readFileSync(specPath, "utf8")) as unknown };
    agentLabel = `inline:${specPath}`;
  } else {
    agent = { name: target.agent };
    agentLabel = target.agent;
  }

  const trueforgeUrl = resolveTrueforgeUrl(process.env.TRUEFORGE_URL, config.trueforgeUrl);
  const tf = new TrueForgeClient(trueforgeUrl);
  let labels: LabelOps | null = null;
  if (args.labels) {
    labels =
      ticket.source === "jira"
        ? new JiraStatus(requireJira(config), process.env.JIRA_EMAIL ?? "", process.env.JIRA_API_KEY ?? "")
        : new GitHubLabels(repo, process.env.GITHUB_PAT ?? "");
  }

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
    issue: ticket.source === "github" ? ticket.number : null,
    ...(ticket.source === "jira" ? { ticket: ticket.key, jiraCloudId: requireJira(config).cloudId } : {}),
    mode: args.mode,
    scenarioId: scenario?.id ?? null,
    agent,
    agentLabel,
    prompt: args.prompt ?? kickoff(ticket, args.mode, localDate(), config),
    timeoutMin,
    repoRoot: root,
    trueforgeUrl,
    repo,
  };
  const ref = ticket.source === "github" ? ticketRef(ticket, repo) : `${ticketRef(ticket, repo)} -> ${repo}`;
  print(
    `shipgate: ${ticketRunId(ticket, opts.scenarioId)} · ${ref} · agent ${agentLabel} · ` +
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
      if (e instanceof ConfigError) {
        process.stderr.write(`shipgate: ${e.message}\n`);
        process.exit(2);
      }
      if (e instanceof UsageError) process.stderr.write(`${e.message}\n`);
      else process.stderr.write(`error: ${process.env.SHIPGATE_DEBUG ? (e as Error)?.stack : (e as Error)?.message ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
