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
import { beginJobCancellation, cancellationOwnerState, writeJobFile, readJobFile, transitionJob, reapStaleJobs } from "../scripts/lib/state.mjs";

function fixture(run) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-ownership-"));
  const realKill = process.kill;
  const realNow = Date.now;
  try {
    assert.equal(spawnSync("git", ["init", "--initial-branch=main"], { cwd: repo }).status, 0);
    process.kill = (_pid, signal) => {
      assert.equal(signal, 0);
      throw Object.assign(new Error("owned fixture is gone"), { code: "ESRCH" });
    };
    writeJobFile(repo, "job", { id: "job", workspaceRoot: repo, status: "running", pid: 2_147_483_000, pidIdentity: "target-start", createdAt: new Date().toISOString() });
    return run(repo);
  } finally {
    process.kill = realKill;
    Date.now = realNow;
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

it("captures the cancelling actor identity with the transition and current target", () => fixture(repo => {
  const result = beginJobCancellation(repo, "job", { identityImpl: pid => { assert.equal(pid, process.pid); return "owner-start"; } });
  assert.equal(result.transitioned, true);
  assert.equal(result.job.cancelOwnerPid, process.pid);
  assert.equal(result.job.cancelOwnerIdentity, "owner-start");
  assert.equal(result.job.pidIdentity, "target-start");
  assert.deepEqual(readJobFile(repo, "job"), result.job);
}));

for (const identityImpl of [() => "", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }]) {
  it("refuses an unavailable owner identity before changing stored state and releases the lock", () => fixture(repo => {
    const before = readJobFile(repo, "job");
    assert.throws(() => beginJobCancellation(repo, "job", { identityImpl }), /identity is unavailable/);
    assert.deepEqual(readJobFile(repo, "job"), before);
    assert.equal(beginJobCancellation(repo, "job", { identityImpl: () => "verified-owner" }).transitioned, true);
  }));
}

it("does not require an owner probe for queued cancellation without a PID", () => fixture(repo => {
  transitionJob(repo, "job", ["running"], "queued", { pid: null, pidIdentity: null });
  const result = beginJobCancellation(repo, "job", { identityImpl: () => assert.fail("no asynchronous cancellation") });
  assert.equal(result.transitioned, true);
  assert.equal(result.job.cancelOwnerPid, undefined);
}));

it("does not probe or overwrite a terminal winner", () => fixture(repo => {
  transitionJob(repo, "job", ["running"], "completed");
  const result = beginJobCancellation(repo, "job", { identityImpl: () => assert.fail("CAS already lost") });
  assert.equal(result.transitioned, false);
  assert.equal(result.job.status, "completed");
}));

for (const status of ["completed", "failed", "cancelled", "cancel_failed", "running"]) {
  it(`clears cancellation ownership on transition to ${status}`, () => fixture(repo => {
    beginJobCancellation(repo, "job", { identityImpl: () => "owner-start" });
    transitionJob(repo, "job", ["cancelling"], status);
    const current = readJobFile(repo, "job");
    assert.equal(current.cancelOwnerPid, undefined);
    assert.equal(current.cancelOwnerIdentity, undefined);
  }));
}

const owner = { cancelOwnerPid: 123, cancelOwnerIdentity: "owner-start" };
it("recognises a matching owner identity", () => {
  assert.equal(cancellationOwnerState(owner, { identityImpl: () => "owner-start" }), "live");
});
it("recognises a reused PID by its different identity", () => {
  assert.equal(cancellationOwnerState(owner, { identityImpl: () => "different-start" }), "gone");
});
const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
it("does not infer a verified owner from a bare positive PID probe", () => {
  assert.equal(cancellationOwnerState(owner, { identityImpl: denied, killImpl: (_pid, signal) => { assert.equal(signal, 0); } }), "unknown");
});
it("retains uncertainty when both probes are denied", () => {
  assert.equal(cancellationOwnerState(owner, { identityImpl: denied, killImpl: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } }), "unknown");
});
it("recovers a gone owner despite an unavailable identity probe", () => {
  assert.equal(cancellationOwnerState(owner, { identityImpl: denied, killImpl: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), "gone");
});
it("treats missing ownership as legacy recovery", () => {
  assert.equal(cancellationOwnerState({}), "gone");
});

for (const gone of [false, true]) {
  it(`handles uncertain identity with owner ${gone ? "gone" : "still present"} without trusting PID identity`, () => fixture(repo => {
    const pending = beginJobCancellation(repo, "job", { identityImpl: () => "owner-start" }).job;
    const epoch = Math.max(...[pending.updatedAt, pending.createdAt].map(Date.parse));
    Date.now = () => epoch + 2_001;
    const result = reapStaleJobs(repo, [pending], { identityImpl: denied, killImpl: () => { if (gone) throw Object.assign(new Error("gone"), { code: "ESRCH" }); } })[0];
    assert.equal(result.status, gone ? "failed" : "cancelling");
  }));
}
