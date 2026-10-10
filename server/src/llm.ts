// Calls Claude through the local Claude Code CLI in headless mode, so the user's
// Claude subscription is used instead of an API key.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import type { Metric } from "@dung/shared";

export type LlmCall<T> = {
  kind: Metric["kind"];
  model: "haiku" | "sonnet";
  system: string;
  user: string;
  schema: z.ZodType<T>;
  key?: string;
  /** --effort for this call; env LLM_EFFORT_<KIND> overrides it. */
  effort?: "low" | "medium" | "high";
};

export type LlmResult<T> = { data: T; metric: Metric };

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 180_000);

/** Thrown when Claude can't be used at all (usage/rate limit, not logged in): the game must block. */
export class LimitError extends Error {
  metric?: Metric;
  reason: "limit" | "auth";
  constructor(message: string) {
    super(message);
    this.reason = AUTH_RE.test(message) && !LIMIT_RE.test(message) ? "auth" : "limit";
  }
}

const LIMIT_RE = /usage limit|rate limit|limit reached|hit your limit|quota|overloaded|429/i;
const AUTH_RE = /not logged in|log ?in|authenticat|unauthori[sz]ed|invalid api key|401|403/i;
const isBlocking = (text: string) => LIMIT_RE.test(text) || AUTH_RE.test(text);

/**
 * CLAUDE_CMD may carry leading VAR=value assignments and extra args, e.g.
 * `CLAUDE_CONFIG_DIR=~/.claude-om claude`. With CLAUDE_USE_SHELL=1 the command runs
 * through an interactive login shell instead, so shell aliases resolve too.
 */
function resolveCommand(args: string[]) {
  const cmd = process.env.CLAUDE_CMD?.trim() || "claude";
  if (process.env.CLAUDE_USE_SHELL === "1") {
    const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
    const shell = process.env.SHELL ?? "/bin/zsh";
    return { bin: shell, args: ["-ic", `${cmd} ${args.map(quote).join(" ")}`], env: process.env };
  }
  const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? ["claude"];
  const unquote = (t: string) => t.replace(/^(["'])(.*)\1$/, "$2").replace(/^~(?=\/|$)/, homedir());
  const env = { ...process.env };
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const [name, ...rest] = tokens.shift()!.split("=");
    env[name] = unquote(rest.join("="));
  }
  const [bin, ...pre] = tokens.map(unquote);
  return { bin, args: [...pre, ...args], env };
}

type CliResult = {
  is_error: boolean;
  api_error_status?: number | null;
  subtype: string;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

/** The CLI's validator rejects the draft-2020-12 `$schema` marker zod adds. */
function jsonSchema(schema: z.ZodType) {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return JSON.stringify(rest);
}

function runCli(call: LlmCall<unknown>, prompt: string): Promise<CliResult> {
  const args = [
    "-p",
    "--model", call.model,
    "--output-format", "json",
    "--json-schema", jsonSchema(call.schema),
    "--system-prompt", call.system,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--setting-sources", "",
  ];
  const effort = process.env[`LLM_EFFORT_${call.kind.toUpperCase()}`] || process.env.LLM_EFFORT || call.effort;
  if (effort) args.push("--effort", effort);
  const cmd = resolveCommand(args);
  return new Promise((resolve, reject) => {
    // Run outside the repo so no CLAUDE.md or project settings leak into the prompt.
    const child = spawn(cmd.bin, cmd.args, { cwd: tmpdir(), env: cmd.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      // Interactive shells may print noise before the JSON; take the last JSON line.
      const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        const text = `claude exited ${code}: ${(err || out).trim().slice(0, 400)}`;
        reject(isBlocking(text) ? new LimitError(text) : new Error(text));
      }
    });
    child.stdin.end(prompt);
  });
}

let dumpSeq = 0;
/** SPIKE: keep every raw exchange for inspection (LLM_DUMP_DIR, set by the server). */
function dump(call: LlmCall<unknown>, prompt: string, res: unknown) {
  const dir = process.env.LLM_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${dumpSeq++}-${call.kind}${call.key ? `-${call.key}` : ""}.json`;
  writeFileSync(join(dir, name), JSON.stringify({ model: call.model, system: call.system, prompt, res }, null, 1));
}

/** One call plus one retry that feeds the validation error back. Throws if both fail. */
export async function llm<T>(call: LlmCall<T>): Promise<LlmResult<T>> {
  const started = Date.now();
  const metric: Metric = {
    at: started,
    kind: call.kind,
    model: call.model,
    ms: 0,
    ok: false,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    key: call.key,
  };
  let prompt = call.user;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    metric.retries = attempt;
    try {
      const res = await runCli(call as LlmCall<unknown>, prompt);
      dump(call as LlmCall<unknown>, prompt, res);
      metric.inputTokens += res.usage?.input_tokens ?? 0;
      metric.outputTokens += res.usage?.output_tokens ?? 0;
      metric.cacheRead += res.usage?.cache_read_input_tokens ?? 0;
      metric.cacheWrite += res.usage?.cache_creation_input_tokens ?? 0;
      if (res.is_error) {
        const text = `claude: ${res.subtype} ${res.result ?? ""}`.slice(0, 400);
        throw res.api_error_status === 429 || isBlocking(text) ? new LimitError(text) : new Error(text);
      }
      const parsed = call.schema.safeParse(res.structured_output ?? JSON.parse(res.result ?? "null"));
      if (parsed.success) {
        metric.ok = true;
        metric.ms = Date.now() - started;
        return { data: parsed.data, metric };
      }
      lastError = z.prettifyError(parsed.error).slice(0, 1500);
    } catch (e) {
      if (e instanceof LimitError) {
        metric.ms = Date.now() - started;
        metric.error = e.message;
        e.metric = metric;
        throw e; // retrying a limit only burns time
      }
      lastError = (e as Error).message;
    }
    prompt = `${call.user}\n\nYour previous answer was invalid:\n${lastError}\nReturn a corrected answer.`;
  }
  metric.ms = Date.now() - started;
  metric.error = lastError;
  throw Object.assign(new Error(lastError), { metric });
}
