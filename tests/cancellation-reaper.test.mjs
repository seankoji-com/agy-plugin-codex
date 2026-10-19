/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import "./support/isolate-codex-home.mjs";
import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getProcessIdentity } from "../scripts/lib/process.mjs";
import { writeJobFile, readJobFile, transitionJob, reapStaleJobs } from "../scripts/lib/state.mjs";

const DEAD_TARGET_PID = 2_147_483_000;
const DEAD_OWNER_PID = 2_147_482_999;

function fixture(run) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-reaper-contract-"));
  const realNow = Date.now;
  const realKill = process.kill;
  const clock = { now: realNow() };
  const probes = [];
  try {
    assert.equal(spawnSync("git", ["init", "--initial-branch=main"], { cwd: repo }).status, 0);
    Date.now = () => clock.now;
    // Only zero-signal liveness probes are allowed. Never signal any PID.
    process.kill = (pid, signal) => {
      assert.equal(signal, 0, "the fixture must not deliver a signal");
      probes.push(pid);
      if (pid === process.pid) return true;
      assert.ok(pid === DEAD_TARGET_PID || pid === DEAD_OWNER_PID, "unexpected PID probe");
      throw Object.assign(new Error("fixture process is gone"), { code: "ESRCH" });
    };
    const job = {
      id: "fixture-job", workspaceRoot: repo, status: "running",
      pid: DEAD_TARGET_PID, pidIdentity: null,
      createdAt: new Date(clock.now).toISOString(),
      startedAt: new Date(clock.now).toISOString(),
    };
    writeJobFile(repo, job.id, job);
    const activeOwner = { cancelOwnerPid: process.pid, cancelOwnerIdentity: getProcessIdentity(process.pid) };
    assert.ok(typeof activeOwner.cancelOwnerIdentity === "string" && activeOwner.cancelOwnerIdentity.length > 0);
    const enter = (extra = {}) => {
      assert.equal(transitionJob(repo, job.id, ["running"], "cancelling", extra).transitioned, true);
      const current = readJobFile(repo, job.id);
      clock.now = Math.max(...[current.updatedAt, current.startedAt, current.createdAt].map(Date.parse)) + 2_001;
      return current;
    };
    return run({ repo, job, enter, activeOwner, clock, probes });
  } finally {
    Date.now = realNow;
    process.kill = realKill;
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

it("keeps a cancelling record while its owner identity is live after target death", { skip: process.platform === "win32" }, () => fixture(({ repo, job, enter, activeOwner }) => {
  const pending = enter(activeOwner);
  const result = reapStaleJobs(repo, [pending])[0];
  assert.equal(result.status, "cancelling");
  assert.equal(readJobFile(repo, job.id).status, "cancelling");
}));

it("lets the owner commit cancelled after an interleaved status reap", { skip: process.platform === "win32" }, () => fixture(({ repo, job, enter, activeOwner }) => {
  const pending = enter(activeOwner);
  reapStaleJobs(repo, [pending]);
  const final = transitionJob(repo, job.id, ["cancelling"], "cancelled", { pid: null, pidIdentity: null });
  assert.equal(final.transitioned, true);
  assert.equal(final.job.status, "cancelled");
  assert.equal(readJobFile(repo, job.id).status, final.job.status);
}));

it("recovers an abandoned cancellation when its owner identity is gone", { skip: process.platform === "win32" }, () => fixture(({ repo, job, enter }) => {
  const pending = enter({ cancelOwnerPid: DEAD_OWNER_PID, cancelOwnerIdentity: "fixture-gone" });
  assert.equal(reapStaleJobs(repo, [pending])[0].status, "failed");
  assert.match(readJobFile(repo, job.id).errorMessage, /Auto-reaped/);
}));

it("does not treat a recycled owner PID with a different identity as live", { skip: process.platform === "win32" }, () => fixture(({ repo, enter }) => {
  const pending = enter({ cancelOwnerPid: process.pid, cancelOwnerIdentity: "different-process-start" });
  assert.equal(reapStaleJobs(repo, [pending])[0].status, "failed");
}));

it("keeps legacy abandoned cancelling-job recovery without ownership fields", { skip: process.platform === "win32" }, () => fixture(({ repo, enter }) => {
  assert.equal(reapStaleJobs(repo, [enter()])[0].status, "failed");
}));

it("does not let owner metadata protect a dead running job", { skip: process.platform === "win32" }, () => fixture(({ repo, job, enter, activeOwner }) => {
  enter(activeOwner);
  transitionJob(repo, job.id, ["cancelling"], "running");
  const current = readJobFile(repo, job.id);
  current.updatedAt = current.startedAt;
  assert.equal(reapStaleJobs(repo, [current])[0].status, "failed");
}));

it("leaves a completed job untouched regardless of stale owner metadata", { skip: process.platform === "win32" }, () => fixture(({ repo, job, enter, activeOwner }) => {
  enter(activeOwner);
  transitionJob(repo, job.id, ["cancelling"], "completed");
  assert.equal(reapStaleJobs(repo, [readJobFile(repo, job.id)])[0].status, "completed");
}));
