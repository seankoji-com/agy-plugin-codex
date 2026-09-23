/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("isolates state from inherited plugin data and removes its temporary home", () => {
  const inheritedHome = mkdtempSync(join(tmpdir(), "agy-inherited-home-"));
  const marker = join(inheritedHome, "preserve.txt");
  writeFileSync(marker, "installed data");
  try {
    const child = spawnSync(process.execPath, [
      "--import", fileURLToPath(new URL("./support/isolate-codex-home.mjs", import.meta.url)),
      "--input-type=module", "-e",
      `import { ensureStateDir, resolveStateDir } from "./scripts/lib/state.mjs";
       ensureStateDir(process.cwd());
       console.log(JSON.stringify({ home: process.env.CODEX_HOME, state: resolveStateDir(process.cwd()) }));`,
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: inheritedHome, PLUGIN_DATA: inheritedHome, AGY_PLUGIN_DATA: inheritedHome },
    });
    assert.equal(child.status, 0, child.stderr);
    const { home, state } = JSON.parse(child.stdout);
    assert.notEqual(home, inheritedHome);
    assert.ok(state.startsWith(join(home, "plugins", "data", "agy")));
    assert.equal(existsSync(home), false, "temporary state is cleaned on exit");
    assert.equal(readFileSync(marker, "utf8"), "installed data");
  } finally {
    rmSync(inheritedHome, { recursive: true, force: true });
  }
});
