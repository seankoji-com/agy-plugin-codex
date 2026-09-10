/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ported from claude-cli.mjs (Claude Code bridge) to the Google Antigravity
 * CLI (`agy`). Spawns `agy -p` subprocesses per invocation.
 *
 * Transport contract (verified against agy 1.1.28):
 * - Non-interactive execution is `agy --model <model> ... -p "<prompt>"`.
 *   `-p` consumes the NEXT argument as the prompt value, so every flag must
 *   precede it and the prompt must be the final argument (`-p=<prompt>`).
 * - `agy` rejects bare `flash-medium`-style aliases client-side; the plugin
 *   therefore maps friendly aliases to catalog model IDs (e.g.
 *   `flash-medium` -> `gemini-3.8-flash-medium`). Unknown names pass through
 *   untouched and `agy` validates them.
 * - With `--output-format json`, each turn prints a single JSON envelope on
 *   stdout: { conversation_id, status: "SUCCESS"|"ERROR", response, error,
 *   duration_seconds, num_turns, usage }.
 * - `agy` has no headless auth probe; local auth state is detected from
 *   `~/.gemini/antigravity-cli/` (oauth token + settings.json).
 * - `agy -p` cannot read the prompt from stdin, so prompts travel in argv and
 *   are capped per platform to stay inside OS argument-buffer limits.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProcessIdentity, validateProcessIdentity } from "./process.mjs";

const AGY_PACKAGE_EXE_PARTS = ["node_modules", "agy", "bin", "agy.exe"];

/** @visibleForTesting */
export function resolveAgyBin(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  const existsSync = options.existsSync ?? fs.existsSync;
  const override = String(env.AGY_PLUGIN_CODEX_AGY_BIN ?? "").trim();

  if (override) {
    return override;
  }
  if (platform !== "win32") {
    return "agy";
  }

  const pathApi = path.win32;
  const searchRoots = [];
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  for (const entry of String(pathValue).split(pathApi.delimiter)) {
    const normalized = entry.trim().replace(/^"|"$/g, "");
    if (normalized) searchRoots.push(normalized);
  }
  if (env.npm_config_prefix) searchRoots.push(String(env.npm_config_prefix));
  if (env.APPDATA) searchRoots.push(pathApi.join(String(env.APPDATA), "npm"));
  searchRoots.push(pathApi.join(homedir, "AppData", "Roaming", "npm"));

  const seenRoots = new Set();
  for (const root of searchRoots) {
    const resolvedRoot = pathApi.resolve(root);
    const rootKey = resolvedRoot.toLowerCase();
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    const candidates = [
      pathApi.join(resolvedRoot, "agy.exe"),
      pathApi.join(resolvedRoot, ...AGY_PACKAGE_EXE_PARTS),
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Continue to the next candidate, then fall back to normal PATH lookup.
      }
    }
  }
  return "agy";
}

const AGY_BIN = resolveAgyBin();
export const MAX_STDERR_BYTES = 64 * 1024;

export const DEFAULT_TURN_TIMEOUT_MS = 120_000;
export const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;

/**
 * Hard cap on the prompt delivered through argv. Windows process creation
 * carries the whole command line (CreateProcess limit ~32k chars); POSIX
 * shells allow far more but a single argument is still bounded. The review
 * context collector already omits oversized diffs, so this guard only trips
 * on pathological inputs.
 */
export const MAX_PROMPT_ARG_CHARS =
  process.platform === "win32" ? 20_000 : 90_000;

function sliceTextTailByBytes(text, maxBytes) {
  const normalized = typeof text === "string" ? text : String(text ?? "");
  if (!normalized || maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(mid), "utf8") > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let start = low;
  let retained = normalized.slice(start);
  while (start < normalized.length && Buffer.byteLength(retained, "utf8") > maxBytes) {
    start += 1;
    retained = normalized.slice(start);
  }
  return retained;
}

function appendTextTail(existing, chunk, maxBytes) {
  const next = `${existing ?? ""}${chunk ?? ""}`;
  return sliceTextTailByBytes(next, maxBytes);
}

// ---------------------------------------------------------------------------
// Availability & auth
// ---------------------------------------------------------------------------

export function getAgyAvailability(cwd) {
  try {
    const result = spawnSync(AGY_BIN, ["--version"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("non-zero exit");
    return { available: true, detail: (result.stdout ?? "").trim() };
  } catch {
    return { available: false, detail: "agy CLI not found in PATH" };
  }
}

/**
 * Detect local Antigravity auth state.
 *
 * `agy` has no headless `auth status` command, so presence of the Antigravity
 * CLI state under ~/.gemini is the proxy (matches the plugin setup contract:
 * "valid local auth state (~/.gemini/antigravity-cli/settings.json or
 * keyring)"). Presence does not guarantee the OAuth token is still fresh; a
 * stale token surfaces later as a failed/timeout turn, which callers treat as
 * a non-blocking warning rather than a crash.
 */
export function getAgyAuthStatus(cwd, options = {}) {
  const home = options.homedir ?? os.homedir();
  const existsSync = options.existsSync ?? fs.existsSync;
  const candidates = [
    path.join(home, ".gemini", "antigravity-cli", "settings.json"),
    path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    path.join(home, ".gemini", "settings.json"),
  ];
  const present = candidates.filter((candidate) => existsSync(candidate));
  if (present.length > 0) {
    return {
      available: true,
      loggedIn: true,
      detail: "Antigravity auth state found under ~/.gemini",
      evidence: present.map((candidate) =>
        candidate.replace(`${home}${path.sep}`, "~/")
      ),
    };
  }
  return {
    available: true,
    loggedIn: false,
    detail:
      "not authenticated — run `agy` once and complete Google sign-in",
    evidence: [],
  };
}

// ---------------------------------------------------------------------------
// Output envelope parsing
// ---------------------------------------------------------------------------

const SERVICE_LIMIT_PATTERNS = [
  /quota/i,
  /rate\s*limit/i,
  /\b429\b/,
  /too many requests/i,
  /resource exhausted|RESOURCE_EXHAUSTED/i,
  /billing/i,
  /unavailable/i,
  /try again later/i,
];

export function looksLikeServiceLimit(text) {
  const source = String(text ?? "");
  return SERVICE_LIMIT_PATTERNS.some((pattern) => pattern.test(source));
}

/**
 * Extract the agy JSON envelope from stdout. agy may print non-JSON chatter
 * before the envelope (or the envelope may be absent entirely on hard
 * failures), so we scan for the LAST JSON object that carries the envelope
 * keys.
 */
export function extractAgyEnvelope(stdout) {
  const source = String(stdout ?? "");
  let best = null;
  for (
    let start = source.indexOf("{");
    start !== -1;
    start = source.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index++) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (
              parsed &&
              typeof parsed === "object" &&
              Object.prototype.hasOwnProperty.call(parsed, "status")
            ) {
              best = parsed;
            }
          } catch {
            // Malformed candidate — keep scanning.
          }
          break;
        }
      }
    }
  }
  return best;
}

function envelopeConversationId(envelope) {
  return typeof envelope?.conversation_id === "string" && envelope.conversation_id
    ? envelope.conversation_id
    : null;
}

function envelopeResponse(envelope) {
  if (envelope == null) return "";
  if (typeof envelope.response === "string") return envelope.response;
  return "";
}

function envelopeError(envelope) {
  if (envelope == null) return "";
  if (typeof envelope.error === "string") return envelope.error;
  return "";
}

function envelopeStatus(envelope) {
  return typeof envelope?.status === "string" ? envelope.status : "ERROR";
}

function resolveTurnResult({
  envelope,
  stdout,
  stderr,
  exitCode,
  timedOut,
}) {
  const status = envelopeStatus(envelope);
  const conversationId = envelopeConversationId(envelope);
  const response = envelopeResponse(envelope);
  const envelopeErrorText = envelopeError(envelope);
  const combinedError = `${envelopeErrorText}\n${stderr}`.trim();
  const serviceLimited = looksLikeServiceLimit(combinedError);

  if (timedOut) {
    return {
      status: "failed",
      warning: `agy timed out after ${DEFAULT_TURN_TIMEOUT_MS / 1000}s without completing the turn.`,
      exitCode: null,
      conversationId,
      finalMessage: response,
      structuredOutput: null,
      stderr: stderr || "[agy] print timeout",
      serviceLimited: false,
    };
  }

  if (status === "SUCCESS") {
    return {
      status: "completed",
      warning: null,
      exitCode: exitCode ?? 0,
      conversationId,
      finalMessage: response,
      structuredOutput: null,
      stderr,
      serviceLimited: false,
    };
  }

  if (serviceLimited) {
    // Rate limits / quota exhaustion are transient. Report them distinctly so
    // callers can fail open (warn) instead of blocking a Codex turn.
    return {
      status: "failed",
      warning: `Antigravity service limit hit: ${firstLine(combinedError) || "quota or rate limit"}`,
      exitCode: exitCode ?? 1,
      conversationId,
      finalMessage: "",
      structuredOutput: null,
      stderr: combinedError,
      serviceLimited: true,
    };
  }

  if (envelopeErrorText) {
    return {
      status: "failed",
      warning: firstLine(envelopeErrorText),
      exitCode: exitCode ?? 1,
      conversationId,
      finalMessage: "",
      structuredOutput: null,
      stderr: combinedError,
      serviceLimited: false,
    };
  }

  if (exitCode !== 0) {
    return {
      status: "failed",
      warning: firstLine(stderr) || `agy exited with code ${exitCode}`,
      exitCode,
      conversationId,
      finalMessage: response,
      structuredOutput: null,
      stderr,
      serviceLimited: false,
    };
  }

  return {
    status: "unknown",
    warning:
      "agy exited 0 without a recognizable result envelope; treat output as raw text",
    exitCode: 0,
    conversationId,
    finalMessage: stdout,
    structuredOutput: null,
    stderr,
    serviceLimited: false,
  };
}

function firstLine(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  return normalized.split(/\r?\n/, 1)[0].trim();
}

// ---------------------------------------------------------------------------
// Model & effort selection
// ---------------------------------------------------------------------------

export const EFFORT_ALIASES = {
  none: "low",
  minimal: "low",
  xhigh: "high",
  max: "high",
};

export const VALID_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * Friendly default: the issue spec targets "Gemini 3.8 Flash with Medium
 * thinking" and exposes the alias `flash-medium`. agy 1.1.28 rejects bare
 * `flash-medium` as a model name (verified), so the plugin owns the alias →
 * catalog-ID mapping. IDs follow `agy models` output.
 */
export const DEFAULT_MODEL = "flash-medium";

export const MODEL_ALIASES = {
  "flash-low": "gemini-3.8-flash-low",
  "flash-medium": "gemini-3.8-flash-medium",
  "flash-high": "gemini-3.8-flash-high",
};

export function resolveDefaultModel(model) {
  if (model == null || String(model).trim() === "") {
    return DEFAULT_MODEL;
  }
  return model;
}

export function resolveModel(model) {
  if (model == null) return undefined;
  const normalized = String(model).trim();
  if (!normalized) return undefined;
  const alias = MODEL_ALIASES[normalized.toLowerCase()];
  return alias ?? normalized;
}

export function resolveEffort(effort) {
  if (!effort) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  const resolved = EFFORT_ALIASES[normalized] ?? normalized;
  if (VALID_EFFORTS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `Unsupported effort "${effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`
  );
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Build the CLI argument array for `agy -p`.
 *
 * Invocation contract (verified against agy 1.1.28):
 * - `-p` consumes the next token as its prompt value, so the prompt must be
 *   the FINAL argument and every other flag must precede it.
 * - The prompt is delivered as `-p=<prompt>` to keep a repository-sized
 *   prompt out of the shell's positional-token confusion.
 */
/** @visibleForTesting */
export function buildAgyArgs(prompt, options = {}) {
  const args = [];

  const requestedModel = resolveDefaultModel(options.model);
  const model = resolveModel(requestedModel);
  if (model) {
    args.push("--model", model);
  }
  const effort = resolveEffort(options.effort);
  if (effort) {
    args.push("--effort", effort);
  }
  args.push("--output-format", "json");

  // Default to read-only plan mode. Reviews and gates must never be able to
  // modify the workspace unless the caller explicitly opts into accept-edits.
  const mode = options.mode ?? "plan";
  if (mode === "plan") {
    args.push("--mode", "plan");
  } else if (mode === "accept-edits") {
    args.push("--mode", "accept-edits");
  }

  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }
  if (options.jsonSchema) {
    const schema =
      typeof options.jsonSchema === "string"
        ? options.jsonSchema
        : JSON.stringify(options.jsonSchema);
    args.push("--json-schema", schema);
  }

  const rawPrompt = String(prompt ?? "");
  const TRUNCATION_MARKER =
    "\n[agy-plugin-codex] Context truncated to fit the platform command-line limit. " +
    "Inspect remaining changes with read-only git commands.";
  let delivered = rawPrompt;
  if (rawPrompt.length > MAX_PROMPT_ARG_CHARS) {
    delivered = `${rawPrompt.slice(0, MAX_PROMPT_ARG_CHARS)}${TRUNCATION_MARKER}`;
  }
  args.push(`-p=${delivered}`);
  return args;
}

/**
 * Execute an Antigravity turn with `agy -p --output-format json`.
 *
 * Returns { status, warning, exitCode, conversationId, finalMessage,
 * structuredOutput, stderr, pid, pidIdentity, serviceLimited }.
 *
 * `status` values: "completed" (SUCCESS envelope), "failed" (ERROR envelope,
 * non-zero exit, service limit, or timeout), "unknown" (no envelope).
 */
export async function runAgyTurn(cwd, prompt, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TURN_TIMEOUT_MS;
  const args = buildAgyArgs(prompt, options);

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(AGY_BIN, args, {
        cwd,
        env: options.env
          ? { ...process.env, ...options.env }
          : undefined,
        detached: true, // new process group for safe cancellation
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        status: "failed",
        warning: `Failed to spawn agy: ${error.message}`,
        exitCode: -1,
        conversationId: null,
        finalMessage: "",
        structuredOutput: null,
        stderr: error.message,
        pid: null,
        pidIdentity: null,
        serviceLimited: false,
      });
      return;
    }

    let pidIdentity = null;
    try {
      pidIdentity = getProcessIdentity(proc.pid);
    } catch {
      // Best-effort — may fail on some platforms
    }

    if (options.onSpawn) {
      options.onSpawn({ pid: proc.pid, pidIdentity });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancelAgyProcess(proc.pid, pidIdentity).catch(() => {});
    }, timeoutMs);

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr = appendTextTail(stderr, chunk, MAX_STDERR_BYTES);
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout = appendTextTail(stdout, chunk, MAX_STDERR_BYTES * 4);
      if (options.onProgress) {
        options.onProgress({ kind: "text", text: chunk, phase: "running" });
      }
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const envelope = extractAgyEnvelope(stdout);
      resolve({
        ...resolveTurnResult({
          envelope,
          stdout,
          stderr,
          exitCode: proc.exitCode,
          timedOut,
        }),
        pid: proc.pid,
        pidIdentity,
      });
    };

    proc.on("close", finish);
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "failed",
        warning: err.message,
        exitCode: -1,
        conversationId: null,
        finalMessage: "",
        structuredOutput: null,
        stderr: err.message,
        pid: proc.pid,
        pidIdentity,
        serviceLimited: false,
      });
    });

    // Unref only for background workers — foreground callers need the process to keep Node alive
    if (options.background) {
      proc.unref();
    }
  });
}

/**
 * Execute a review turn (read-only, no writes). Defaults to agy `--mode plan`
 * so the delegated review cannot modify the workspace.
 */
export async function runAgyReview(cwd, prompt, options = {}) {
  const result = await runAgyTurn(cwd, prompt, {
    mode: options.write ? "accept-edits" : "plan",
    ...options,
  });

  return {
    status: result.status,
    exitCode: result.exitCode,
    warning: result.warning,
    result: result.finalMessage,
    structuredOutput: result.structuredOutput ?? null,
    conversationId: result.conversationId,
    stderr: result.stderr,
    pid: result.pid,
    pidIdentity: result.pidIdentity,
    serviceLimited: result.serviceLimited ?? false,
  };
}

/**
 * Execute an adversarial review with JSON schema output.
 */
export async function runAgyAdversarialReview(cwd, prompt, schema, options = {}) {
  return runAgyReview(cwd, prompt, {
    jsonSchema: schema,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Cancellation — process-group based, identity-verified
// ---------------------------------------------------------------------------

/**
 * Cancel a running agy process.
 * Uses process group kill with PID identity verification.
 */
export async function cancelAgyProcess(pid, pidIdentity) {
  // Verify PID identity to prevent killing recycled PIDs
  if (pidIdentity && !validateProcessIdentity(pid, pidIdentity)) {
    return {
      cancelled: true,
      note: "Process already exited (PID recycled)",
    };
  }

  // SIGTERM to entire process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return { cancelled: true, note: "Process not found" };
  }

  // Wait for process group to die
  const dead = await waitForProcessGroup(pid, 5000);
  if (dead) {
    return { cancelled: true };
  }

  // Escalate to SIGKILL
  if (pidIdentity && !validateProcessIdentity(pid, pidIdentity)) {
    return {
      cancelled: true,
      note: "Process exited during SIGTERM wait",
    };
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {}

  const killedDead = await waitForProcessGroup(pid, 3000);
  if (killedDead) {
    return { cancelled: true };
  }

  return {
    cancelled: false,
    note: `Process group ${pid} still alive after SIGKILL`,
  };
}

function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroup(pgid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessGroupAlive(pgid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessGroupAlive(pgid);
}
