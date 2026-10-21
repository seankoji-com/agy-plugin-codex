/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import "../support/isolate-codex-home.mjs";
import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { testHomeEnv } from "../support/test-home-env.mjs";
import { writeJobFile, readJobFile } from "../../scripts/lib/state.mjs";
import { getProcessIdentity } from "../../scripts/lib/process.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const companion = path.join(root, "scripts/agy-companion.mjs");
const childFixture = path.join(root, "tests/support/cancel-cas-child.mjs");

async function runCase(kind) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-command-cas-"));
  const id = `cancel-${kind}`;
  const env = testHomeEnv(process.env.HOME);
  // Share the state helper's isolated Codex home with both owned children.
  env.CODEX_HOME = process.env.CODEX_HOME;
  delete env.AGY_COMPANION_SESSION_ID;
  let worker, command, workerExit, commandExit;
  try {
    assert.equal(spawnSync("git", ["init", "--initial-branch=main"], { cwd: repo }).status, 0);
    if (kind !== "queued") {
      worker = fork(childFixture, [repo, id, kind], { env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      workerExit = once(worker, "exit");
      const [ready] = await once(worker, "message");
      assert.equal(ready.ready, true);
    }
    const identity = worker ? getProcessIdentity(worker.pid) : null;
    if (worker) assert.ok(typeof identity === "string" && identity.length > 0);
    writeJobFile(repo, id, {
      id, title: "Owned cancellation CAS fixture", workspaceRoot: repo,
      kind: "task", jobClass: "task", status: worker ? "running" : "queued",
      phase: worker ? "running" : "queued", pid: worker?.pid ?? null,
      pidIdentity: identity, createdAt: new Date().toISOString(),
    });
    command = spawn(process.execPath, [companion, "cancel", "--cwd", repo, "--json", id], { env, stdio: ["ignore", "pipe", "pipe"] });
    commandExit = once(command, "close");
    let stdout = "", stderr = "";
    command.stdout.on("data", data => { stdout += data; });
    command.stderr.on("data", data => { stderr += data; });
    const [code, signal] = await commandExit;
    if (workerExit) await workerExit;
    const stored = readJobFile(repo, id);
    const payload = JSON.parse(stdout);
    const event = kind === "race" ? JSON.parse(fs.readFileSync(path.join(repo, "fixture-cas.json"), "utf8")) : null;
    const receipt = { kind, argv: [companion, "cancel", "--cwd", repo, "--json", id], code, signal, payload, stored, event, stderr, workerPid: worker?.pid ?? null, identity };
    if (process.env.CANCEL_CAS_EVIDENCE) {
      fs.writeFileSync(path.join(process.env.CANCEL_CAS_EVIDENCE, `${kind}.json`), JSON.stringify(receipt, null, 2) + "\n");
    }
    assert.equal(code, 0, stderr);
    if (kind === "race") {
      assert.equal(event.previousStatus, "cancelling");
      assert.equal(event.transitioned, true);
      assert.equal(stored.status, "completed");
    } else {
      assert.equal(stored.status, "cancelled");
    }
    assert.equal(payload.status, stored.status, "cancel response must agree with the committed job status");
  } finally {
    // Only captured handles from this fixture can be stopped here.
    // A command that never spawned has no PID and may never emit close.
    if (command?.pid && command.exitCode === null && command.signalCode === null) { command.kill("SIGKILL"); await commandExit.catch(() => {}); }
    if (worker && worker.exitCode === null && worker.signalCode === null) { worker.kill("SIGKILL"); await workerExit; }
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

it("reports the stored winner when a controlled actor wins the final cancellation CAS", { timeout: 15000, skip: process.platform === "win32" }, () => runCase("race"));
it("keeps ordinary live-process cancellation working", { timeout: 15000, skip: process.platform === "win32" }, () => runCase("normal"));
it("keeps queued cancellation without a PID working", { timeout: 15000, skip: process.platform === "win32" }, () => runCase("queued"));
