/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("isolates state from inherited plugin data and removes its temporary home", () => {
  const inheritedHome = mkdtempSync(join(tmpdir(), "agy-inherited-home-"));
  const marker = join(inheritedHome, "preserve.txt");
  writeFileSync(marker, "installed data");
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      `await import(${JSON.stringify(new URL("./support/isolate-codex-home.mjs", import.meta.url).href)});
       const { ensureStateDir, resolveStateDir } = await import("./scripts/lib/state.mjs");
       ensureStateDir(process.cwd());
       console.log(JSON.stringify({ home: process.env.CODEX_HOME, state: resolveStateDir(process.cwd()) }));`,
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, CODEX_HOME: inheritedHome, PLUGIN_DATA: inheritedHome, AGY_PLUGIN_DATA: inheritedHome },
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

it("installer and hook children preserve an inherited installed home", () => {
  const inheritedHome = mkdtempSync(join(tmpdir(), "agy-installed-sentinel-"));
  const sentinels = [
    "config.toml",
    "plugins/cache/seankoji-com/agy/2.0.1/package.json",
    "plugins/data/cc/sentinel.json",
    "plugins/data/claude-code/sentinel.json",
  ];
  try {
    for (const file of sentinels) {
      const destination = join(inheritedHome, file);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, file === "config.toml" ? '[plugins."agy@seankoji-com"]\nenabled = true\n' : "preserve installed data");
    }
    const before = sentinels.map((file) => readFileSync(join(inheritedHome, file), "utf8"));
    const child = spawnSync(process.execPath, [
      "--test", "--test-name-pattern=installs through Codex marketplace/add|uninstalls cleanly while preserving unrelated user config|enables native plugin hooks",
      "tests/installer-cli.test.mjs", "tests/install-hooks.test.mjs",
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, CODEX_HOME: inheritedHome, PLUGIN_DATA: inheritedHome, AGY_PLUGIN_DATA: inheritedHome },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /installs through Codex marketplace\/add/);
    assert.match(child.stdout, /uninstalls cleanly while preserving unrelated user config/);
    assert.match(child.stdout, /enables native plugin hooks/);
    assert.match(child.stdout, /(?:#|ℹ) pass 3\b/);
    assert.deepEqual(sentinels.map((file) => readFileSync(join(inheritedHome, file), "utf8")), before);
  } finally {
    rmSync(inheritedHome, { recursive: true, force: true });
  }
});

it("stateful unit suites and child home overrides declare isolation", () => {
  const testsDir = fileURLToPath(new URL("./", import.meta.url));
  for (const name of readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"))) {
    const source = readFileSync(join(testsDir, name), "utf8");
    if (/from ["']\.\.\/scripts\/lib\/(?:state|tracked-jobs|job-control)\.mjs/.test(source)) {
      assert.ok(source.includes('import "./support/isolate-codex-home.mjs"'), `${name} needs isolated state`);
    }
    for (const [, env] of source.matchAll(/\.\.\.process\.env,([\s\S]*?)\n\s*\}/g)) {
      if (/\bHOME:/.test(env)) {
        assert.ok(/\bCODEX_HOME:/.test(env), `${name} overrides HOME without CODEX_HOME; use testHomeEnv`);
      }
    }
  }
});
