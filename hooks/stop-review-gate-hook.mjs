#!/usr/bin/env node

/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turn-end review gate hook for Codex — Antigravity bridge.
 *
 * Flow:
 * 1. Check config.stopReviewGate — if disabled -> exit 0.
 * 2. If agy is not ready, log setup guidance and allow stop to continue.
 * 3. Run a targeted turn-end review of the previous Codex response.
 * 4. Parse ALLOW:/BLOCK: from the review's output (§6.1 gate rubric).
 * 5. If the review returns BLOCK, keep the Codex turn active.
 * 6. Service-limit failures fail open (ALLOW with a warning) — a quota error
 *    must not wedge an edit-producing Codex turn.
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { cleanupAfterOfficialUninstall } from "./lib/plugin-install-guard.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../scripts/lib/prompts.mjs";
import {
  appendStopReviewHistory,
  generateJobId,
  getCurrentSession,
  getConfig,
  listJobs,
  nowIso,
  readTurnBaseline,
  writeStopReviewSnapshot
} from "../scripts/lib/state.mjs";
import {
  getAgyAuthStatus,
  getAgyAvailability,
  runAgyReview,
} from "../scripts/lib/agy-cli.mjs";
import { getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";
import { SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const SKIP_INTERACTIVE_HOOKS_ENV = "AGY_COMPANION_SKIP_INTERACTIVE_HOOKS";
const STOP_REVIEW_SUCCESS_NOTE = "Antigravity turn-end review passed.";
const STOP_REVIEW_NO_EDIT_NOTE =
  "Antigravity turn-end review skipped: the most recent turn made no net edits.";
const STOP_REVIEW_NO_BASELINE_NOTE =
  "Antigravity turn-end review skipped: no user turn was recorded for this Codex session.";
const STOP_REVIEW_SERVICE_LIMIT_NOTE =
  "Antigravity service limit hit; the turn-end review gate failed open (ALLOW) so the turn could finish.";
const MAX_INLINE_REASON_CHARS = 1_500;

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function boundReasonForHookOutput(reason, runId) {
  const text = String(reason ?? "");
  if (text.length <= MAX_INLINE_REASON_CHARS) {
    return text;
  }
  const suffix = [
    "",
    "",
    `Full stop-review output was saved in the ${runId} snapshot.`
  ].join("\n");
  return `${text.slice(0, MAX_INLINE_REASON_CHARS).trimEnd()}…${suffix}`;
}

function buildSetupNote(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    return `Antigravity is not set up for the review gate. ${availability.detail}. Run $agy:setup.`;
  }

  const authStatus = getAgyAuthStatus(cwd);
  if (!authStatus.loggedIn) {
    const detail = authStatus.detail ? ` ${authStatus.detail}.` : "";
    return `Antigravity is not set up for the review gate.${detail} Run $agy:setup and, if needed, \`agy\` once to complete Google sign-in.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const previousResponseBlock = lastAssistantMessage
    ? [
        "<previous_codex_response>",
        lastAssistantMessage,
        "</previous_codex_response>",
      ].join("\n")
    : "";
  return interpolateTemplate(template, {
    PREVIOUS_RESPONSE_BLOCK: previousResponseBlock
  });
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      rawOutput: text,
      firstLine: "",
      reason:
        "The turn-end Antigravity review returned no output. Run $agy:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  const allowIndex = text.indexOf("ALLOW:");
  const blockIndex = text.indexOf("BLOCK:");
  const markerIndex =
    allowIndex === -1
      ? blockIndex
      : blockIndex === -1
        ? allowIndex
        : Math.min(allowIndex, blockIndex);
  const contractText = markerIndex >= 0 ? text.slice(markerIndex).trim() : text;
  const contractFirstLine = contractText.split(/\r?\n/, 1)[0].trim();

  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null, rawOutput: text, firstLine };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      rawOutput: text,
      firstLine,
      reason: `Antigravity turn-end review found issues that still need fixes before ending this Codex turn: ${reason}`
    };
  }
  if (contractFirstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null, rawOutput: text, firstLine: contractFirstLine };
  }
  if (contractFirstLine.startsWith("BLOCK:")) {
    const reason =
      contractFirstLine.slice("BLOCK:".length).trim() || contractText;
    return {
      ok: false,
      rawOutput: text,
      firstLine: contractFirstLine,
      reason: `Antigravity turn-end review found issues that still need fixes before ending this Codex turn: ${reason}`
    };
  }

  return {
    ok: false,
    rawOutput: text,
    firstLine,
    reason:
      "The turn-end Antigravity review returned an unexpected answer. Run $agy:review --wait manually or bypass the gate."
  };
}

// ---------------------------------------------------------------------------
// Review execution via the agy CLI
// ---------------------------------------------------------------------------

async function runStopReview(cwd, input = {}) {
  const prompt = buildStopReviewPrompt(input);
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  try {
    // agy `--mode plan` is inherently read-only; no sandbox settings or MCP
    // config are needed for the gate review.
    const result = await runAgyReview(cwd, prompt, {});

    const agyFields = {
      agyStatus: result.status ?? null,
      agyExitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      agyWarning: result.warning ?? null,
      agyStderr: result.stderr ?? "",
      agyConversationId: result.conversationId ?? null,
      promptBytes,
    };

    if (result.serviceLimited) {
      // Fail open: quota/rate-limit errors are transient, and blocking the
      // Codex turn because Antigravity is throttled would wedge the user.
      return {
        ok: true,
        rawOutput: String(result.result ?? "").trim(),
        firstLine: "ALLOW:",
        serviceLimitedAllow: true,
        reason: null,
        ...agyFields,
      };
    }

    if (result.status !== "completed") {
      const detail = String(
        result.warning || result.stderr || ""
      ).trim();
      return {
        ok: false,
        rawOutput: String(result.result ?? "").trim(),
        firstLine: "",
        serviceLimitedAllow: false,
        reason: detail
          ? `The turn-end Antigravity review failed: ${detail}`
          : "The turn-end Antigravity review failed. Run $agy:review --wait manually or bypass the gate.",
        ...agyFields,
      };
    }

    return {
      ...parseStopReviewOutput(result.result),
      serviceLimitedAllow: false,
      ...agyFields,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      rawOutput: "",
      firstLine: "",
      serviceLimitedAllow: false,
      agyStatus: "error",
      agyExitCode: null,
      agyWarning: null,
      agyStderr: detail,
      agyConversationId: null,
      promptBytes,
      reason: `The turn-end Antigravity review failed: ${detail}`
    };
  }
}

// ---------------------------------------------------------------------------
// Running job check
// ---------------------------------------------------------------------------

function filterJobsForCurrentSession(jobs, sessionId = null) {
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function checkRunningJobs(workspaceRoot, sessionId = null) {
  const jobs = filterJobsForCurrentSession(listJobs(workspaceRoot), sessionId);
  const sorted = [...jobs].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
  const runningJob = sorted.find(
    (job) => job.status === "queued" || job.status === "running"
  );
  return runningJob
    ? `Antigravity task ${runningJob.id} is still running. Check $agy:status and use $agy:cancel ${runningJob.id} if you want to stop it.`
    : null;
}

function summarizeFingerprint(fingerprint) {
  if (!fingerprint) {
    return null;
  }
  const { repoRoot, ...summary } = fingerprint;
  return summary;
}

function evaluateTurnEditGate(cwd, workspaceRoot, sessionId) {
  if (!sessionId) {
    return {
      shouldSkipReview: false,
      reason: "No session id available for turn-baseline comparison.",
      baseline: null,
      current: null,
    };
  }

  const baseline = readTurnBaseline(workspaceRoot, sessionId);
  if (!baseline?.fingerprint) {
    // The baseline is written by UserPromptSubmit, so its absence means no user
    // prompt drove this Codex session and there is no turn to review. Reachable
    // when another host drives Codex headlessly, e.g. a Claude Code review
    // thread that inherits this plugin (see lib/host-origin.mjs).
    return {
      shouldSkipReview: true,
      skipStatus: "skipped_no_turn_baseline",
      skipNote: STOP_REVIEW_NO_BASELINE_NOTE,
      reason: "No turn baseline was recorded for this session.",
      baseline,
      current: null,
    };
  }

  try {
    const current = getWorkingTreeFingerprint(cwd);
    const baselineFingerprint = baseline.fingerprint;
    const signaturesMatch =
      baselineFingerprint.signature === current.signature;
    return {
      shouldSkipReview: signaturesMatch,
      reason: signaturesMatch
        ? "The most recent turn made no net tracked/untracked edits."
        : "The most recent turn changed the working tree fingerprint.",
      baseline,
      current,
    };
  } catch (error) {
    return {
      shouldSkipReview: false,
      reason:
        error instanceof Error
          ? `Turn-baseline comparison failed: ${error.message}`
          : `Turn-baseline comparison failed: ${String(error)}`,
      baseline,
      current: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (cleanupAfterOfficialUninstall(ROOT_DIR)) {
    return;
  }
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId =
    input.session_id ||
    process.env[SESSION_ID_ENV] ||
    getCurrentSession(workspaceRoot) ||
    null;
  const stopReviewRun = {
    runId: generateJobId("stop"),
    startedAt: nowIso(),
    status: "started",
    agyInvoked: false,
    cwd,
    workspaceRoot,
    sessionId,
    hookSuppressed: process.env[SKIP_INTERACTIVE_HOOKS_ENV] === "1",
    hasLastAssistantMessage: Boolean(
      String(input.last_assistant_message ?? "").trim()
    ),
    lastAssistantMessageChars: String(input.last_assistant_message ?? "").trim().length,
  };
  const persistSnapshot = (patch = {}) =>
    writeStopReviewSnapshot(workspaceRoot, {
      ...stopReviewRun,
      ...patch,
    });
  const persistFinal = (patch = {}) => {
    const snapshot = persistSnapshot({
      ...patch,
      completedAt: nowIso(),
    });
    appendStopReviewHistory(workspaceRoot, snapshot);
    return snapshot;
  };

  if (process.env[SKIP_INTERACTIVE_HOOKS_ENV] === "1") {
    persistFinal({
      status: "skipped_hook_suppressed",
      reason: "Interactive hooks are suppressed for this session.",
    });
    return;
  }

  const config = getConfig(workspaceRoot);
  if (!config.stopReviewGate) {
    persistFinal({
      status: "skipped_config_disabled",
      reason: "stopReviewGate is disabled for this workspace.",
    });
    return;
  }

  const runningTaskNote = checkRunningJobs(workspaceRoot, sessionId);
  const turnEditGate = evaluateTurnEditGate(cwd, workspaceRoot, sessionId);
  const fingerprintFields = {
    baselineFingerprint: summarizeFingerprint(turnEditGate.baseline?.fingerprint),
    currentFingerprint: summarizeFingerprint(turnEditGate.current),
  };
  if (turnEditGate.shouldSkipReview) {
    persistFinal({
      status: turnEditGate.skipStatus ?? "skipped_no_turn_edits",
      reason: turnEditGate.reason,
      agyInvoked: false,
      runningTaskNote,
      ...fingerprintFields,
    });
    logNote(turnEditGate.skipNote ?? STOP_REVIEW_NO_EDIT_NOTE);
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    persistFinal({
      status: "skipped_agy_not_ready",
      reason: setupNote,
      runningTaskNote,
      ...fingerprintFields,
    });
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  persistSnapshot({
    status: "running_agy_review",
    agyInvoked: true,
    runningTaskNote,
    ...fingerprintFields,
  });
  const review = await runStopReview(cwd, input);
  if (!review.ok) {
    persistFinal({
      status: "blocked",
      agyInvoked: true,
      reason: review.reason,
      rawOutput: review.rawOutput,
      firstLine: review.firstLine,
      agyStatus: review.agyStatus,
      agyExitCode: review.agyExitCode,
      agyWarning: review.agyWarning,
      agyStderr: review.agyStderr,
      agyConversationId: review.agyConversationId,
      promptBytes: review.promptBytes,
      runningTaskNote,
      ...fingerprintFields,
    });
    const inlineReason = runningTaskNote
      ? `${runningTaskNote} ${review.reason}`
      : review.reason;
    emitDecision({
      decision: "block",
      reason: boundReasonForHookOutput(inlineReason, stopReviewRun.runId),
    });
    return;
  }

  persistFinal({
    status: "allow",
    agyInvoked: true,
    reason: review.serviceLimitedAllow
      ? STOP_REVIEW_SERVICE_LIMIT_NOTE
      : STOP_REVIEW_SUCCESS_NOTE,
    serviceLimitedAllow: review.serviceLimitedAllow ?? false,
    rawOutput: review.rawOutput,
    firstLine: review.firstLine,
    agyStatus: review.agyStatus,
    agyExitCode: review.agyExitCode,
    agyWarning: review.agyWarning,
    agyStderr: review.agyStderr,
    agyConversationId: review.agyConversationId,
    promptBytes: review.promptBytes,
    runningTaskNote,
    ...fingerprintFields,
  });
  logNote(
    review.serviceLimitedAllow
      ? STOP_REVIEW_SERVICE_LIMIT_NOTE
      : STOP_REVIEW_SUCCESS_NOTE
  );
  logNote(runningTaskNote);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
