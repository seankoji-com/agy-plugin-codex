/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import before state helpers so unit tests never migrate or write installed data.
const testCodexHome = mkdtempSync(join(tmpdir(), "agy-unit-codex-home-"));
process.env.CODEX_HOME = testCodexHome;
delete process.env.PLUGIN_DATA;
delete process.env.AGY_PLUGIN_DATA;
process.on("exit", () => rmSync(testCodexHome, { recursive: true, force: true }));
