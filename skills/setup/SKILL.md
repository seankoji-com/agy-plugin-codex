---
name: setup
description: 'Check whether Antigravity CLI is ready in this environment and optionally toggle the turn-end review gate. Args: --enable-review-gate, --disable-review-gate. Use for installation, authentication, or review-gate setup requests.'
---

# Antigravity Setup

Use this skill when the user wants to verify Antigravity readiness or toggle the review gate.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root.

Supported arguments:
- `--enable-review-gate`
- `--disable-review-gate`

Workflow:
- First run the machine-readable probe:
  `node "<plugin-root>/scripts/agy-companion.mjs" setup --json $ARGUMENTS`
- If it reports that the Antigravity CLI is unavailable and `curl` is available, ask whether to install it now.
- If the user agrees, install per the official Antigravity CLI installer (https://antigravity.google/cli/install.sh), which registers `agy` to `~/.local/bin/agy`, then rerun setup. Do not attempt an npm install of `agy`.
- If the Antigravity CLI is already installed or `curl` is unavailable, do not ask about installation.
- If setup reports missing native plugin hook features or hook trust, rerun setup once. The companion repairs `[features].hooks` and this plugin's native hook trust hashes itself.
- If setup adds the plugin-data destination or legacy migration roots to the writable-root list, do not retry in the same Codex session. Tell the user to restart Codex and rerun the same setup command; any requested review-gate change is deliberately deferred until that restart.
- After the decision flow is complete, run the final user-facing command without `--json`:
  `node "<plugin-root>/scripts/agy-companion.mjs" setup $ARGUMENTS`

Output:
- Present the final non-JSON setup output exactly as returned by the companion.
- Use the JSON form only for branching logic such as install or auth decisions.
- Preserve any authentication guidance if setup reports that login is still required.
