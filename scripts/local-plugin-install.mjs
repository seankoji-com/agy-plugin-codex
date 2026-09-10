#!/usr/bin/env node

/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */

console.error(
  [
    "Local checkout installs are no longer supported.",
    "Install agy from this Codex marketplace so Codex owns the active plugin cache:",
    "  codex marketplace add seankoji-com/agy-plugin-codex",
    "Then install `agy` from that marketplace and run `$agy:setup`.",
  ].join("\n")
);
process.exit(1);
