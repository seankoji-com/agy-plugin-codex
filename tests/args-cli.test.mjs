/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import "./support/isolate-codex-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { testHomeEnv } from "./support/test-home-env.mjs";

const companion = fileURLToPath(new URL("../scripts/agy-companion.mjs", import.meta.url));

it("routes single-quoted raw cwd to the same repository as ordinary argv", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-raw-cwd-"));
  try {
    // Windows paths already contain separators; POSIX needs a literal backslash.
    const name = process.platform === "win32" ? "workspace with spaces" : "workspace\\branch with spaces";
    const workspace = path.join(root, name);
    const home = path.join(root, "home");
    fs.mkdirSync(workspace);
    fs.mkdirSync(home);
    const env = { ...testHomeEnv(home), CODEX_THREAD_ID: "raw-cwd-fixture" };
    const init = spawnSync("git", ["init", "--quiet", workspace], { env, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    function routing(args) {
      const result = spawnSync(process.execPath, [companion, "session-routing-context", ...args], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).workspaceRoot;
    }

    const ordinary = routing(["--cwd", workspace, "--json"]);
    const raw = routing([`--cwd '${workspace}' --json`]);
    assert.equal(fs.realpathSync(ordinary), fs.realpathSync(workspace));
    assert.equal(raw, ordinary);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
