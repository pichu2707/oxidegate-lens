// test/plugin-tools.test.mjs
//
// STATIC assert of the tool-name graduation in opencode/oxidegate-lens.ts —
// `oxidegate_lens_experimental_mcp_status/_connect/_disconnect` becoming
// `oxidegate_lens_mcp_valve/_connect/_disconnect`.
//
// WHY THIS TEST EXISTS
// ---------------------
// A consumer's `opencode.json` enables these tools BY NAME. Renaming a tool
// silently DISABLES it in any config that still names the old identifier —
// there is no error, no warning, no deprecation notice; the tool simply
// vanishes from the agent's available toolset. This file cannot be
// `node --test`-executed like the rest of the suite: it is TypeScript, and
// this repo's runner is plain `node --test` over `.mjs` files (see
// design.md Decision 1 — the plugin is untestable at runtime under Strict
// TDD, so the plugin's logic is a thin adapter over lib/*.mjs). A STATIC
// text assertion — reading the file as a string, never importing or
// executing it — is the only thing standing between a rename and that
// silent breakage: it fails loudly, in CI, the moment an old name is
// removed without the new one being present, or the moment a stale old
// name lingers alongside the new one.
//
// NOTE for the maintainer: this repo's OWN local `opencode.json` (untracked,
// not committed) still names the OLD tool identifiers as of this change. It
// must be updated by hand — this test only protects the plugin source
// against a silent rename; it cannot see or fix a consumer's config file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, '../opencode/oxidegate-lens.ts');
const source = readFileSync(PLUGIN_PATH, 'utf8');

const GRADUATED_NAMES = ['oxidegate_lens_mcp_valve', 'oxidegate_lens_mcp_connect', 'oxidegate_lens_mcp_disconnect'];

const OLD_NAMES = [
  'oxidegate_lens_experimental_mcp_status',
  'oxidegate_lens_experimental_mcp_connect',
  'oxidegate_lens_experimental_mcp_disconnect',
];

// Pinned VERBATIM so a future reword of the caveat is caught here, not
// discovered by a consumer reading a silently different warning.
const WARNING_TEXT =
  'Manual runtime control only. This does not promise same-request lazy MCP behavior or outgoing tool-list mutation.';

test('the three graduated tool names are registered', () => {
  for (const name of GRADUATED_NAMES) {
    assert.ok(source.includes(name), `expected graduated tool name "${name}" in opencode/oxidegate-lens.ts`);
  }
});

test('none of the old experimental_mcp_* tool names remain anywhere in the file', () => {
  for (const name of OLD_NAMES) {
    assert.ok(!source.includes(name), `stale old tool name "${name}" must not remain — it silently disables in any config still naming it`);
  }
});

test('valveResult no longer carries a stale "experiment:" key; "caveat:" is present instead', () => {
  assert.doesNotMatch(source, /\bexperiment\s*:/, 'stale "experiment:" key must not remain in valveResult');
  assert.match(source, /\bcaveat\s*:/, 'expected "caveat:" key in valveResult');
});

test('the warning string is preserved verbatim', () => {
  assert.ok(source.includes(WARNING_TEXT), 'warning string must be present verbatim — a reword must fail this test');
});
