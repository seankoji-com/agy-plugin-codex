/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testHomeEnv } from "./support/test-home-env.mjs";

const cli = fileURLToPath(new URL("../scripts/agy-companion.mjs", import.meta.url));
const stateUrl = new URL("../scripts/lib/state.mjs", import.meta.url).href;
const roots = [];
function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function fixture(jobs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-queued-status-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  const env = { ...testHomeEnv(home), AGY_COMPANION_SESSION_ID: "owner-a" };
  run("git", ["init", "--initial-branch=main"], { cwd, env });
  // Import state only inside a child whose temporary home is already set.
  run(process.execPath, ["--input-type=module", "-e", `
    const { writeJobFile } = await import(process.argv[1]);
    const cwd = process.argv[2];
    for (const job of JSON.parse(process.argv[3])) writeJobFile(cwd, job.id, {
      workspaceRoot: cwd, sessionId: "owner-a", jobClass: "task",
      createdAt: "2026-10-19T00:00:00Z", pid: null, phase: job.status, ...job,
    });
  `, stateUrl, cwd, JSON.stringify(jobs)], { cwd, env });
  return {
    status: (...args) => run(process.execPath, [cli, "status", ...args, "--cwd", cwd], { cwd, env }),
    result: (id) => JSON.parse(run(process.execPath, [cli, "result", id, "--json", "--cwd", cwd], { cwd, env })),
  };
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

for (const jobClass of ["review", "task"]) {
  it(`lists a queued ${jobClass} in default/all CLI overview and preserves ID recovery`, () => {
    const id = `queued-${jobClass}`;
    const f = fixture([{ id, status: "queued", jobClass }]);
    for (const args of [["--json"], ["--all", "--json"]]) {
      const overview = JSON.parse(f.status(...args));
      assert.deepEqual(overview.running.map((job) => job.id), [id]);
      assert.equal(overview.running[0].status, "queued");
      assert.equal(overview.running[0].phase, "queued");
      assert.equal(overview.latestFinished, null);
      assert.deepEqual(overview.recent, []);
    }
    const text = f.status();
    assert.ok(text.includes(id));
    assert.doesNotMatch(text, /No Antigravity jobs recorded yet/);
    const single = JSON.parse(f.status(id, "--json"));
    assert.equal(single.job.id, id);
    assert.equal(single.job.status, "queued");
    const result = f.result(id);
    assert.equal(result.state, "active");
    assert.equal(result.job.status, "queued");
  });
}

it("keeps session filtering and mixed active/finished states in the CLI overview", () => {
  const f = fixture([
    { id: "queued-a", status: "queued" },
    { id: "running-a", status: "running" },
    { id: "cancelling-a", status: "cancelling" },
    { id: "done-a", status: "completed", completedAt: "2026-10-19T00:00:01Z" },
    { id: "queued-b", status: "queued", sessionId: "owner-b" },
  ]);
  const own = JSON.parse(f.status("--json"));
  assert.deepEqual(own.running.map((job) => job.id).sort(), ["cancelling-a", "queued-a", "running-a"]);
  assert.equal(own.latestFinished.id, "done-a");
  const all = JSON.parse(f.status("--all", "--json"));
  assert.deepEqual(all.running.map((job) => job.id).sort(), ["cancelling-a", "queued-a", "queued-b", "running-a"]);
  assert.equal(all.latestFinished.id, "done-a");
});
