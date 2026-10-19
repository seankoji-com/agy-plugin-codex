/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";

import { ensureGitRepository } from "./git.mjs";

/**
 * Windows reaches one directory through several spellings: an 8.3 short name
 * (e.g. `RUNNER~1`), its long name, and either slash style. The workspace root
 * is the identity used for state and job directories, so resolve it to the
 * canonical spelling before returning it. Without this, `--cwd` pointing at the
 * same repository as a short name and as a long name produced two workspace
 * roots and split the plugin state between them.
 *
 * POSIX spellings are returned unchanged: a symlinked checkout keeps the name
 * the caller used, which is how every other platform-dependent path is handled.
 */
function canonicalizeWorkspacePath(candidate, platform = process.platform) {
  if (platform !== "win32") {
    return candidate;
  }
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
