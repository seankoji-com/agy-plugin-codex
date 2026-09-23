/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

it("uses the verified marketplace credential for checkout, PR creation, and merge", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/update-marketplace.yml", import.meta.url),
    "utf8"
  );
  const verified = workflow.match(/MARKETPLACE_TOKEN:\s*\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/);
  assert.ok(verified, "the workflow must verify its marketplace credential");
  const consumers = [...workflow.matchAll(/(?:token|GH_TOKEN):\s*\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)];
  assert.equal(consumers.length, 3, "checkout, PR creation, and merge each need authentication");
  for (const [, secret] of consumers) {
    assert.equal(secret, verified[1], "each operation must use the credential that was checked");
  }
});
