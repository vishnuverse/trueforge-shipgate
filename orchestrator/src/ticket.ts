// Which ticket a run works on: an issue of shipgate.yaml target.repo (GitHub) or a ticket of jira.project (Jira).
// Naming only; the agent and its skill make every judgement.
import { ConfigError, jiraKeyRe, ticketNames, type Config, type JiraConfig } from "./config.ts";
import type { Mode } from "./decide.ts";

export type Ticket = { source: "github"; number: number } | { source: "jira"; key: string };

/** Saved agent names (agents/*.json), one per ticket source. `--agent` overrides. */
export const GITHUB_AGENT = "ticket-resolver";
export const JIRA_AGENT = "ticket-resolver-jira";

export function defaultAgent(t: Ticket): string {
  return t.source === "github" ? GITHUB_AGENT : JIRA_AGENT;
}

/** config.jira, or a ConfigError (exit 2) when shipgate.yaml has no jira: section. */
export function requireJira(config: Config): JiraConfig {
  if (!config.jira) {
    throw new ConfigError("jira: not configured; add a jira: section to shipgate.yaml to run Jira tickets (--ticket)");
  }
  return config.jira;
}

/** A Jira key of the configured project, exactly as Jira writes it (KAN-4). Lower case or other projects refused. */
export function parseJiraKey(raw: string, jira: JiraConfig): string {
  const re = jiraKeyRe(jira.project);
  if (re.test(raw)) return raw;
  const upper = raw.toUpperCase();
  const hint = re.test(upper)
    ? `; Jira keys are upper case: ${upper}`
    : /^[A-Z][A-Z0-9]+-\d+$/.test(upper)
      ? `; only project ${jira.project} is configured`
      : "";
  throw new Error(
    `${JSON.stringify(raw)} is not a ${jira.project} ticket key (expected ${jira.project}-<n>, e.g. ${jira.project}-4)${hint}`,
  );
}

/** What LabelOps is called with: the issue number (GitHub) or the key (Jira). */
export function ticketId(t: Ticket): number | string {
  return t.source === "github" ? t.number : t.key;
}

/** Human-readable reference: `vishnuverse/humanize#1` or `KAN-4`. */
export function ticketRef(t: Ticket, repo: string): string {
  return t.source === "github" ? `${repo}#${t.number}` : t.key;
}

/** runs/<run id>/: the scenario id, else `issue-<n>` (GitHub) or the key (Jira). */
export function ticketRunId(t: Ticket, scenarioId: string | null = null): string {
  return scenarioId ?? (t.source === "github" ? `issue-${t.number}` : t.key);
}

export function jiraBrowseUrl(jira: JiraConfig, key: string): string {
  return `https://${jira.site}/browse/${key}`;
}

/**
 * First message of a Jira run. The Jira skill parses this exact format; the date lives here (not in the agent's
 * instructions) so the system prompt stays byte-identical across days.
 */
export function jiraKickoff(key: string, config: Config, mode: Mode, today: string): string {
  const jira = requireJira(config);
  const k = parseJiraKey(key, jira);
  const names = ticketNames(k, config.testsDir);
  return (
    `Resolve Jira ticket ${k} (${jiraBrowseUrl(jira, k)}) for the GitHub repo ${config.repo}. ` +
    `cloudId: ${jira.cloudId}. Branch: ${names.branch}. Test file: ${names.testFile}. ` +
    `Approval mode: ${mode}. Today is ${today}.`
  );
}
