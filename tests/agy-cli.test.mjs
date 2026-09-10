/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// IMPORT ORDERING CONTRACT
//
// agy-cli.mjs resolves `const AGY_BIN = resolveAgyBin()` at module import, and
// `resolveAgyBin` honors `process.env.AGY_PLUGIN_CODEX_AGY_BIN`. Any test
// importing the module must therefore point that env var at a fake agy binary
// BEFORE the dynamic import evaluates. We build the fake script first, set the
// env var, then `await import()` the module. Never run real `agy`.
// ---------------------------------------------------------------------------

const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-test-"));
const fakeBin = path.join(fakeBinDir, "agy");

function fakeAgySource() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (process.env.AGY_ARGS_FILE) {
  fs.writeFileSync(process.env.AGY_ARGS_FILE, JSON.stringify(args, null, 2) + "\\n", "utf8");
}
const scheduleTestOnClose = () => {
  if (process.env.AGY_CLOSE_EVENT_FILE) {
    // Gracefully let the parent observe the close path.
    setTimeout(() => {
      fs.writeFileSync(process.env.AGY_CLOSE_EVENT_FILE, "closed", "utf8");
    }, 5);
  }
};

if (args[0] === "--version") {
  process.stdout.write("1.1.28 (agylocal)\\n");
  process.exit(0);
}

const outputFormatIndex = args.indexOf("--output-format");
if (outputFormatIndex >= 0 && args[outputFormatIndex + 1] === "json") {
  if (process.env.AGY_SLEEP_MS) {
    const delay = Number(process.env.AGY_SLEEP_MS) || 0;
    setTimeout(() => {
      finishTurn();
    }, delay);
    return;
  }
  finishTurn();
  return;
}

function finishTurn() {
  if (process.env.AGY_SILENT_FAIL === "1") {
    process.stderr.write("agy failed: no credentials\\n");
    process.exit(7);
  }
  if (process.env.AGY_NO_ENVELOPE === "1") {
    process.stdout.write("some raw text without an envelope\\n");
    process.exit(0);
  }
  if (process.env.AGY_HUGE_STDERR === "1") {
    process.stderr.write("e".repeat(200 * 1024));
  }
  const envelope = {
    conversation_id: process.env.AGY_CONVERSATION_ID || "conv-default",
    status: process.env.AGY_STATUS || "SUCCESS",
    response: process.env.AGY_RESPONSE || "hello from agy",
    error: process.env.AGY_ERROR || "",
    duration_seconds: 1.5,
    num_turns: 1,
    usage: { total_tokens: 5 },
  };
  process.stdout.write(JSON.stringify(envelope) + "\\n");
  scheduleTestOnClose();
  process.exit(0);
}

process.stderr.write("unexpected args: " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
}

// The fake agy binary is exercised through spawn-based tests (runAgyTurn,
// runAgyReview, runAgyAdversarialReview, cancelAgyProcess). On Windows the
// fake is a bare shebang script that `spawn` cannot execute, so those describe
// blocks are gated to POSIX (getAgyAvailability already encodes win32 as
// unavailable). The pure CPU tests below (resolveAgyBin, buildAgyArgs, models,
// effort, envelope parsing, constants) run on every platform.
fs.writeFileSync(fakeBin, fakeAgySource(), "utf8");
fs.chmodSync(fakeBin, 0o755);
process.env.AGY_PLUGIN_CODEX_AGY_BIN = fakeBin;

let agy;
before(async () => {
  // agy-cli.mjs must be imported AFTER the env var is set (see contract above).
  agy = await import("../scripts/lib/agy-cli.mjs");
});

after(() => {
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

// ===========================================================================
// extractAgyEnvelope
// ===========================================================================

describe("extractAgyEnvelope", () => {
  it("returns the envelope for a SUCCESS blob", () => {
    const envelope = agy.extractAgyEnvelope(
      JSON.stringify({
        conversation_id: "c1",
        status: "SUCCESS",
        response: "done",
      })
    );
    assert.equal(envelope.conversation_id, "c1");
    assert.equal(envelope.status, "SUCCESS");
    assert.equal(envelope.response, "done");
  });

  it("returns the envelope for an ERROR blob", () => {
    const envelope = agy.extractAgyEnvelope(
      JSON.stringify({
        conversation_id: "c2",
        status: "ERROR",
        error: "boom",
      })
    );
    assert.equal(envelope.status, "ERROR");
    assert.equal(envelope.error, "boom");
  });

  it("returns null for malformed or unrelated JSON", () => {
    assert.equal(agy.extractAgyEnvelope("not json at all"), null);
    assert.equal(agy.extractAgyEnvelope('{"foo": 1}'), null);
    assert.equal(agy.extractAgyEnvelope(""), null);
  });

  it("picks the LAST JSON object carrying the envelope's status key", () => {
    const chatter =
      "Starting review\n" +
      JSON.stringify({ status: "SUCCESS", response: "early" }) +
      "\n" +
      JSON.stringify({ status: "ERROR", error: "late failure" }) +
      "\n";
    const envelope = agy.extractAgyEnvelope(chatter);
    assert.equal(envelope.status, "ERROR");
    assert.equal(envelope.error, "late failure");
  });

  it("handles multi-line JSON with nested objects and escaping", () => {
    const blob = JSON.stringify({
      status: "SUCCESS",
      response: "line1\nline2",
      usage: { total_tokens: 12 },
    });
    const envelope = agy.extractAgyEnvelope(blob);
    assert.equal(envelope.status, "SUCCESS");
    assert.equal(envelope.response, "line1\nline2");
  });
});

// ===========================================================================
// looksLikeServiceLimit
// ===========================================================================

describe("looksLikeServiceLimit", () => {
  it("detects common service-limit phrases", () => {
    for (const text of [
      "quota exceeded",
      "Rate limit reached",
      "HTTP 429 Too Many Requests",
      "RESOURCE_EXHAUSTED",
      "billing issue",
      "service unavailable",
      "try again later",
    ]) {
      assert.equal(agy.looksLikeServiceLimit(text), true, text);
    }
  });

  it("does not flag ordinary errors", () => {
    for (const text of ["syntax error", "file not found", "", null, undefined]) {
      assert.equal(agy.looksLikeServiceLimit(text), false, String(text));
    }
  });
});

// ===========================================================================
// resolveAgyBin
// ===========================================================================

describe("resolveAgyBin", () => {
  it("prefers an explicit AGY_PLUGIN_CODEX_AGY_BIN override", () => {
    assert.equal(
      agy.resolveAgyBin({
        env: { AGY_PLUGIN_CODEX_AGY_BIN: " /opt/custom/agy " },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: () => false,
      }),
      "/opt/custom/agy"
    );
  });

  it("finds node_modules/agy/bin/agy.exe under a PATH npm prefix", () => {
    const expected = "D:\\tools\\npm\\node_modules\\agy\\bin\\agy.exe";
    assert.equal(
      agy.resolveAgyBin({
        env: { PATH: "C:\\Windows;D:\\tools\\npm" },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: (candidate) => candidate === expected,
      }),
      expected
    );
  });

  it("finds agy.exe directly on a PATH entry", () => {
    const expected = "D:\\tools\\agy.exe";
    assert.equal(
      agy.resolveAgyBin({
        env: { PATH: "C:\\Windows;D:\\tools" },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: (candidate) => candidate === expected,
      }),
      expected
    );
  });

  it("uses APPDATA as an npm search root", () => {
    const expected = "R:\\Profile\\npm\\node_modules\\agy\\bin\\agy.exe";
    assert.equal(
      agy.resolveAgyBin({
        env: { APPDATA: "R:\\Profile" },
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: (candidate) => candidate === expected,
      }),
      expected
    );
  });

  it("falls back to command lookup on non-win32", () => {
    assert.equal(
      agy.resolveAgyBin({
        env: {},
        platform: "darwin",
        homedir: "/Users/demo",
        existsSync: () => false,
      }),
      "agy"
    );
  });

  it("falls back to command lookup when no windows executable is found", () => {
    assert.equal(
      agy.resolveAgyBin({
        env: {},
        platform: "win32",
        homedir: "C:\\Users\\demo",
        existsSync: () => false,
      }),
      "agy"
    );
  });

  it("deduplicates windows search roots case-insensitively", () => {
    const checked = [];
    agy.resolveAgyBin({
      env: { PATH: "C:\\NPM;c:\\npm" },
      platform: "win32",
      homedir: "C:\\Users\\demo",
      existsSync: (candidate) => {
        checked.push(candidate);
        return false;
      },
    });
    assert.equal(checked.length, 4);
    assert.equal(checked[0].toLowerCase(), "c:\\npm\\agy.exe");
    assert.equal(
      checked[1].toLowerCase(),
      "c:\\npm\\node_modules\\agy\\bin\\agy.exe"
    );
  });
});

// ===========================================================================
// getAgyAuthStatus
// ===========================================================================

describe("getAgyAuthStatus", () => {
  it("detects auth when an antigravity-cli settings.json exists", () => {
    const home = path.join(os.tmpdir(), "agy-auth-home-1");
    const settings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    const realpathSettings = settings.replace(`${home}${path.sep}`, "~/");
    const status = agy.getAgyAuthStatus(process.cwd(), {
      homedir: home,
      existsSync: (candidate) => candidate === settings,
    });
    assert.equal(status.available, true);
    assert.equal(status.loggedIn, true);
    assert.deepEqual(status.evidence, [realpathSettings]);
  });

  it("detects auth from an oauth token file", () => {
    const home = path.join(os.tmpdir(), "agy-auth-home-2");
    const token = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const status = agy.getAgyAuthStatus(process.cwd(), {
      homedir: home,
      existsSync: (candidate) => candidate === token,
    });
    assert.equal(status.loggedIn, true);
  });

  it("reports logged-out when no auth state exists", () => {
    const home = path.join(os.tmpdir(), "agy-auth-home-3");
    const status = agy.getAgyAuthStatus(process.cwd(), {
      homedir: home,
      existsSync: () => false,
    });
    assert.equal(status.available, true);
    assert.equal(status.loggedIn, false);
    assert.deepEqual(status.evidence, []);
  });
});

// ===========================================================================
// getAgyAvailability
// ===========================================================================

describe("getAgyAvailability", () => {
  it("reports available when the fake agy handles --version", () => {
    // AGY_BIN points at our fake script (set before import), so this is safe.
    const maybe = agy.getAgyAvailability(process.cwd());
    assert.equal(
      maybe.available,
      process.platform === "win32" ? false : true
    );
  });
});

// ===========================================================================
// Model & effort selection
// ===========================================================================

describe("models", () => {
  it("DEFAULT_MODEL is flash-medium", () => {
    assert.equal(agy.DEFAULT_MODEL, "flash-medium");
  });

  it("MODEL_ALIASES maps flash aliases to catalog IDs", () => {
    assert.deepEqual(agy.MODEL_ALIASES, {
      "flash-low": "gemini-3.8-flash-low",
      "flash-medium": "gemini-3.8-flash-medium",
      "flash-high": "gemini-3.8-flash-high",
    });
  });

  it("resolveModel maps friendly aliases to catalog IDs", () => {
    assert.equal(agy.resolveModel("flash-medium"), "gemini-3.8-flash-medium");
    assert.equal(agy.resolveModel("FLASH-HIGH"), "gemini-3.8-flash-high");
    assert.equal(agy.resolveModel("  flash-low  "), "gemini-3.8-flash-low");
  });

  it("resolveModel passes unknown names through unchanged", () => {
    assert.equal(agy.resolveModel("gemini-3.8-flash-medium"), "gemini-3.8-flash-medium");
    assert.equal(agy.resolveModel("custom-model"), "custom-model");
  });

  it("resolveModel returns undefined for blank input", () => {
    assert.equal(agy.resolveModel(null), undefined);
    assert.equal(agy.resolveModel(undefined), undefined);
    assert.equal(agy.resolveModel(""), undefined);
    assert.equal(agy.resolveModel("   "), undefined);
  });

  it("resolveDefaultModel defaults to flash-medium", () => {
    assert.equal(agy.resolveDefaultModel(null), "flash-medium");
    assert.equal(agy.resolveDefaultModel(undefined), "flash-medium");
    assert.equal(agy.resolveDefaultModel(""), "flash-medium");
    assert.equal(agy.resolveDefaultModel("   "), "flash-medium");
  });

  it("resolveDefaultModel passes through an explicit model", () => {
    assert.equal(agy.resolveDefaultModel("flash-high"), "flash-high");
    assert.equal(agy.resolveDefaultModel("gemini-3.8-flash-low"), "gemini-3.8-flash-low");
  });
});

describe("effort", () => {
  it("EFFORT_ALIASES maps legacy to canonical", () => {
    assert.deepEqual(agy.EFFORT_ALIASES, {
      none: "low",
      minimal: "low",
      xhigh: "high",
      max: "high",
    });
  });

  it("VALID_EFFORTS contains low, medium, high", () => {
    assert.ok(agy.VALID_EFFORTS.has("low"));
    assert.ok(agy.VALID_EFFORTS.has("medium"));
    assert.ok(agy.VALID_EFFORTS.has("high"));
    assert.equal(agy.VALID_EFFORTS.size, 3);
  });

  it("resolveEffort canonicalizes aliases and canonical values", () => {
    assert.equal(agy.resolveEffort("none"), "low");
    assert.equal(agy.resolveEffort("minimal"), "low");
    assert.equal(agy.resolveEffort("xhigh"), "high");
    assert.equal(agy.resolveEffort("max"), "high");
    assert.equal(agy.resolveEffort("low"), "low");
    assert.equal(agy.resolveEffort("medium"), "medium");
    assert.equal(agy.resolveEffort("HIGH"), "high");
  });

  it("resolveEffort throws on unsupported values", () => {
    assert.throws(() => agy.resolveEffort("ultra"), /Unsupported effort "ultra"/);
    assert.throws(() => agy.resolveEffort("???"), /Unsupported effort/);
  });

  it("resolveEffort returns undefined for null/undefined", () => {
    assert.equal(agy.resolveEffort(null), undefined);
    assert.equal(agy.resolveEffort(undefined), undefined);
  });
});

// ===========================================================================
// Constants
// ===========================================================================

describe("constants", () => {
  it("exports transport sizing constants", () => {
    assert.equal(agy.MAX_STDERR_BYTES, 64 * 1024);
    assert.equal(agy.DEFAULT_TURN_TIMEOUT_MS, 120_000);
    assert.equal(agy.DEFAULT_STATUS_WAIT_TIMEOUT_MS, 240_000);
  });

  it("MAX_PROMPT_ARG_CHARS is platform-scaled", () => {
    const expected = process.platform === "win32" ? 20_000 : 90_000;
    assert.equal(agy.MAX_PROMPT_ARG_CHARS, expected);
  });
});

// ===========================================================================
// buildAgyArgs
// ===========================================================================

describe("buildAgyArgs", () => {
  it("orders flags and puts the prompt LAST as -p=", () => {
    const args = agy.buildAgyArgs("do the thing", {
      model: "flash-medium",
      effort: "medium",
      mode: "accept-edits",
      conversationId: "conv-9",
    });
    assert.deepEqual(args, [
      "--model",
      "gemini-3.8-flash-medium",
      "--effort",
      "medium",
      "--output-format",
      "json",
      "--mode",
      "accept-edits",
      "--conversation",
      "conv-9",
      "-p=do the thing",
    ]);
    assert.equal(args.at(-1), "-p=do the thing");
  });

  it("uses plan mode and omits conversation/json-schema when unset", () => {
    const args = agy.buildAgyArgs("p");
    assert.deepEqual(args, [
      "--model",
      "gemini-3.8-flash-medium",
      "--output-format",
      "json",
      "--mode",
      "plan",
      "-p=p",
    ]);
  });

  it("adds --json-schema for review rounds last before -p", () => {
    const schema = { type: "object" };
    const args = agy.buildAgyArgs("review it", { jsonSchema: schema });
    assert.deepEqual(args, [
      "--model",
      "gemini-3.8-flash-medium",
      "--output-format",
      "json",
      "--mode",
      "plan",
      "--json-schema",
      JSON.stringify(schema),
      "-p=review it",
    ]);
  });

  it("truncates oversized prompts and appends a marker", () => {
    const huge = "x".repeat(agy.MAX_PROMPT_ARG_CHARS + 100);
    const args = agy.buildAgyArgs(huge);
    const last = args.at(-1);
    assert.ok(last.startsWith("-p="));
    assert.ok(last.includes("[agy-plugin-codex] Context truncated"));
    // The delivered prompt body is the marker plus at most
    // MAX_PROMPT_ARG_CHARS of the original input.
    const delivered = last.slice("-p=".length);
    const marker = "[agy-plugin-codex] Context truncated";
    assert.ok(delivered.length <= agy.MAX_PROMPT_ARG_CHARS + 512);
    assert.equal(delivered.slice(0, agy.MAX_PROMPT_ARG_CHARS), "x".repeat(agy.MAX_PROMPT_ARG_CHARS));
    assert.ok(delivered.indexOf(marker) > agy.MAX_PROMPT_ARG_CHARS);
  });

  it("keeps short prompts intact without truncation", () => {
    const args = agy.buildAgyArgs("short prompt");
    assert.equal(args.at(-1), "-p=short prompt");
    assert.ok(!args.at(-1).includes("Context truncated"));
  });
});

// ===========================================================================
// runAgyTurn
// ===========================================================================

describe("runAgyTurn", () => {
  // spawn of the fake shebang binary is not possible on Windows; see the
  // module-level comment. The bridge is covered by Full CI on macOS/Ubuntu.
  if (process.platform === "win32") {
    it.skip("spawn-based turn execution (POSIX only)", () => {});
    return;
  }
  // Use a scratch cwd so the spawned fake runs somewhere harmless.
  const cwd = process.cwd();

  async function runTurn(envPatch = {}, options = {}) {
    const argsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agy-args-")),
      "args.json"
    );
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      model: "flash-medium",
      ...options,
    });
    return { result, argsFile };
  }

  it("returns completed on a SUCCESS envelope and forwards the conversation id", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_STATUS: "SUCCESS", AGY_RESPONSE: "all good", AGY_CONVERSATION_ID: "conv-abc" },
      model: "flash-medium",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.warning, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.conversationId, "conv-abc");
    assert.equal(result.finalMessage, "all good");
    assert.equal(result.serviceLimited, false);
  });

  it("returns failed on an ERROR envelope with the error surfaced", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_STATUS: "ERROR", AGY_ERROR: "model rejected prompt" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.warning ?? "", /model rejected prompt/);
    assert.equal(result.finalMessage, "");
  });

  it("marks failed and serviceLimited on a quota-style ERROR envelope", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_STATUS: "ERROR", AGY_ERROR: "Quota exceeded: RESOURCE_EXHAUSTED" },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.serviceLimited, true);
    assert.match(result.warning ?? "", /service limit/i);
  });

  it("returns failed on a non-zero exit without an envelope", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_SILENT_FAIL: "1" },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 7);
    assert.match(result.warning ?? "", /no credentials/);
  });

  it("returns unknown when a zero-exit process emits no recognizable envelope", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_NO_ENVELOPE: "1" },
    });
    assert.equal(result.status, "unknown");
    assert.match(result.warning ?? "", /raw text/);
    assert.equal(result.finalMessage.trim(), "some raw text without an envelope");
  });

  it("times out and reports failed when the turn exceeds the timeout", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_SLEEP_MS: "2000" },
      timeoutMs: 150,
    });
    assert.equal(result.status, "failed");
    assert.match(result.warning ?? "", /timed out/);
    assert.equal(result.exitCode, null);
  });

  it("caps stderr to MAX_STDERR_BYTES", async () => {
    const result = await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_HUGE_STDERR: "1" },
    });
    assert.ok(Buffer.byteLength(result.stderr ?? "", "utf8") <= agy.MAX_STDERR_BYTES);
    assert.equal(result.status, "completed");
  });

  it("invokes with the agy buildAgyArgs contract (prompt last)", async () => {
    const argsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agy-args-")),
      "args.json"
    );
    await agy.runAgyTurn(cwd, "my prompt", {
      env: { AGY_ARGS_FILE: argsFile, AGY_RESPONSE: "ok", AGY_CONVERSATION_ID: "conv-xyz" },
      model: "flash-high",
      effort: "high",
    });
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args.at(-1), "-p=my prompt");
    assert.ok(args.includes("--output-format"));
    assert.equal(args[args.indexOf("--output-format") + 1], "json");
    assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-high");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
  });
});

// ===========================================================================
// runAgyReview / runAgyAdversarialReview
// ===========================================================================

describe("runAgyReview", () => {
  // spawn of the fake shebang binary is not possible on Windows; see the
  // module-level comment.
  if (process.platform === "win32") {
    it.skip("spawn-based review execution (POSIX only)", () => {});
    return;
  }
  it("defaults to plan mode and surfaces result/conversationId/serviceLimited", async () => {
    const argsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agy-args-")),
      "args.json"
    );
    const result = await agy.runAgyReview(process.cwd(), "review prompt", {
      env: {
        AGY_ARGS_FILE: argsFile,
        AGY_RESPONSE: "ALLOW: good",
        AGY_CONVERSATION_ID: "conv-review",
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.result, "ALLOW: good");
    assert.equal(result.conversationId, "conv-review");
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--mode") + 1], "plan");
  });
});

describe("runAgyAdversarialReview", () => {
  // spawn of the fake shebang binary is not possible on Windows; see the
  // module-level comment.
  if (process.platform === "win32") {
    it.skip("spawn-based adversarial review execution (POSIX only)", () => {});
    return;
  }
  it("passes the json schema through buildAgyArgs", async () => {
    const argsFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agy-args-")),
      "args.json"
    );
    const schema = { type: "object", properties: {} };
    const result = await agy.runAgyAdversarialReview(process.cwd(), "adv", schema, {
      env: { AGY_ARGS_FILE: argsFile, AGY_RESPONSE: "{}" },
    });
    assert.equal(result.status, "completed");
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--json-schema") + 1], JSON.stringify(schema));
  });
});

// ===========================================================================
// cancelAgyProcess
// ===========================================================================

describe("cancelAgyProcess", () => {
  it("short-circuits when the PID identity is already recycled", async () => {
    const result = await agy.cancelAgyProcess(process.pid, "not-a-real-identity");
    assert.equal(result.cancelled, true);
    assert.match(result.note ?? "", /recycled/i);
  });
});
