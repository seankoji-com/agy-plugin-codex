/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { join } from "node:path";

export function testHomeEnv(homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEX_HOME: join(homeDir, ".codex"),
    PLUGIN_DATA: undefined,
    AGY_PLUGIN_DATA: undefined,
  };
}
