/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import { transitionJob } from "../../scripts/lib/state.mjs";
const [repo, id, kind] = process.argv.slice(2);
process.once("SIGTERM", () => {
  if (kind === "race") {
    // The signal is the barrier: the command already committed cancelling.
    // Simulate a competing state actor, without changing production modules.
    const result = transitionJob(repo, id, ["cancelling"], "completed", { pid: null, pidIdentity: null, phase: "completed" });
    fs.writeFileSync(path.join(repo, "fixture-cas.json"), JSON.stringify(result));
  }
  process.exit(0);
});
// Ref the IPC channel until SIGTERM; no sleep or polling readiness loop.
process.on("message", () => {});
process.send({ ready: true });
