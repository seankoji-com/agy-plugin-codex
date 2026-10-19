/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";

import { ensureGitRepository } from "./git.mjs";

/**
 * Resolve an existing workspace path to its filesystem spelling. The state
 * directory hash already applies realpath independently; this also keeps the
 * workspaceRoot returned to callers and persisted in jobs consistent.
 */
export function canonicalizeWorkspacePath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

export function resolveWorkspaceRoot(cwd) {
  try {
    return canonicalizeWorkspacePath(ensureGitRepository(cwd));
  } catch {
    return canonicalizeWorkspacePath(cwd);
  }
}
