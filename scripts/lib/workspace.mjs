/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";

import { ensureGitRepository } from "./git.mjs";

/**
 * Resolve the workspace root to the filesystem's canonical spelling before
 * returning it. This unifies Windows short and long names and slash styles,
 * and gives every platform the same identity for a workspace reached through
 * a symlink.
 */
function canonicalizeWorkspacePath(candidate) {
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
