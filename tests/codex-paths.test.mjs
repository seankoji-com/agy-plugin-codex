/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveExpectedPluginDataRoot,
  resolvePluginCacheInstallInfo,
  resolvePluginDataRoot,
  resolveMarketplacePluginDataRoot,
  resolveWritablePluginDataRoots,
} from "../scripts/lib/codex-paths.mjs";

const originalPluginData = process.env.PLUGIN_DATA;
const originalClaudePluginData = process.env.AGY_PLUGIN_DATA;
const originalCodexHome = process.env.CODEX_HOME;
const tempRoots = [];
const PROJECT_VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

afterEach(() => {
  if (originalPluginData === undefined) {
    delete process.env.PLUGIN_DATA;
  } else {
    process.env.PLUGIN_DATA = originalPluginData;
  }
  if (originalClaudePluginData === undefined) {
    delete process.env.AGY_PLUGIN_DATA;
  } else {
    process.env.AGY_PLUGIN_DATA = originalClaudePluginData;
  }
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin data paths", () => {
  it("accepts Codex's injected plugin data root when it matches the install identity", () => {
    const expectedRoot = resolveExpectedPluginDataRoot();
    process.env.PLUGIN_DATA = expectedRoot;
    process.env.AGY_PLUGIN_DATA = "/tmp/codex/plugins/data/cc-other";

    assert.equal(resolvePluginDataRoot(), expectedRoot);
  });

  it("uses AGY_PLUGIN_DATA when PLUGIN_DATA is absent", () => {
    const expectedRoot = resolveExpectedPluginDataRoot();
    delete process.env.PLUGIN_DATA;
    process.env.AGY_PLUGIN_DATA = expectedRoot;

    assert.equal(resolvePluginDataRoot(), expectedRoot);
  });

  it("ignores an injected plugin data root outside the install identity", () => {
    process.env.PLUGIN_DATA = "/";

    assert.equal(resolvePluginDataRoot(), resolveExpectedPluginDataRoot());
  });

  it("accepts a symlink-equivalent injected plugin data root", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-paths-"));
    tempRoots.push(codexHome);
    const actualRoot = path.join(codexHome, "actual-data");
    const expectedRoot = path.join(codexHome, "plugins", "data", "agy");
    fs.mkdirSync(actualRoot, { recursive: true });
    fs.mkdirSync(path.dirname(expectedRoot), { recursive: true });
    fs.symlinkSync(
      actualRoot,
      expectedRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    process.env.CODEX_HOME = codexHome;
    process.env.PLUGIN_DATA = actualRoot;

    assert.equal(resolvePluginDataRoot(), actualRoot);
  });

  it("keeps explicit legacy namespaces independent of injected paths", () => {
    process.env.PLUGIN_DATA = "/tmp/codex/plugins/data/cc-sendbird";

    assert.match(resolvePluginDataRoot("cc"), /plugins[/\\]data[/\\]cc$/);
  });

  it("derives marketplace identity from a managed cache root", () => {
    const codexHome = path.resolve("/tmp/codex-home");
    const pluginRoot = path.join(
      codexHome,
      "plugins",
      "cache",
      "sendbird",
      "agy",
      PROJECT_VERSION
    );

    assert.deepEqual(resolvePluginCacheInstallInfo(pluginRoot, codexHome), {
      marketplaceName: "sendbird",
      pluginName: "agy",
      version: PROJECT_VERSION,
      pluginId: "agy@sendbird",
    });
  });

  it("rejects invalid marketplace names derived from cache paths", () => {
    const codexHome = path.resolve("/tmp/codex-home");
    assert.equal(
      resolvePluginCacheInstallInfo(
        path.join(
          codexHome,
          "plugins",
          "cache",
          "bad name",
          "agy",
          PROJECT_VERSION
        ),
        codexHome
      ),
      null
    );
  });

  it("builds the official marketplace-qualified data root", () => {
    assert.match(
      resolveMarketplacePluginDataRoot("sendbird"),
      /plugins[/\\]data[/\\]agy-sendbird$/
    );
    assert.throws(
      () => resolveMarketplacePluginDataRoot("../outside"),
      /Invalid marketplace name/
    );
  });

  it("includes legacy namespaces needed to migrate marketplace plugin state", () => {
    const primaryRoot = resolveMarketplacePluginDataRoot("sendbird");

    assert.deepEqual(resolveWritablePluginDataRoots(primaryRoot), [
      primaryRoot,
      resolvePluginDataRoot("cc"),
      resolvePluginDataRoot("claude-code"),
    ]);
  });

  it("does not trust injected environment paths for persistent writable roots", () => {
    process.env.PLUGIN_DATA = "/";
    const codexHome = path.resolve("/tmp/codex-home");

    assert.equal(
      resolveExpectedPluginDataRoot("/tmp/source-checkout", codexHome),
      path.join(codexHome, "plugins", "data", "agy")
    );
    assert.equal(
      resolveExpectedPluginDataRoot(
        path.join(
          codexHome,
          "plugins",
          "cache",
          "sendbird",
          "agy",
          PROJECT_VERSION
        ),
        codexHome
      ),
      path.join(codexHome, "plugins", "data", "agy-sendbird")
    );
  });
});
