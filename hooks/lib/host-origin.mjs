/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import process from "node:process";

/**
 * Detect whether this Codex session is hosted by an external assistant rather
 * than a user-driven Codex frontend. A Codex app-server spawned from inside
 * Claude Code inherits the Claude Code process env (measured: CLAUDECODE=1 /
 * CLAUDE_CODE_ENTRYPOINT reach plugin hooks). Threads in such an app-server
 * are host-driven, so companion delegation must not loop back to that host.
 *
 * The Antigravity CLI has no equivalent host marker (verified: agy exposes no
 * env or settings key that identifies a host Codex session), so this probe
 * returns null in the agy world and the companion's delegation guard stays
 * dormant. Keep the machinery so a future host marker can be wired in here
 * without touching callers.
 *
 * Every writer of the current-session marker must stamp this, or a later
 * rewrite would erase the origin and reopen the delegation loop.
 */
export function detectExternalHostOrigin() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude-code";
  }
  return null;
}
