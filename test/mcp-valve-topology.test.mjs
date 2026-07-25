// test/mcp-valve-topology.test.mjs
//
// STATIC assert of design.md Decision 8 — the honesty invariant is enforced
// by MODULE TOPOLOGY, not by discipline. `lib/mcp-valve.mjs` must have no
// import path — direct or transitive — to any call site of
// `client.mcp.connect`, `client.mcp.disconnect`, or `client.mcp.status`. If
// it did, a future edit could quietly wire a recommendation straight into a
// connection-mutating call, defeating the firewall this design depends on.
//
// This test NEVER imports or executes lib/mcp-valve.mjs against a live
// client — there is no client to construct in this test suite, and that is
// the point. It parses the module's own `import` statements, resolves each
// relative specifier to a file, and recurses — so a FUTURE file added to the
// import graph is checked automatically, without maintaining a hardcoded
// file list here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(__dirname, '../lib/mcp-valve.mjs');

// Matches both `import { a } from '...'` and bare `import '...'` forms.
const IMPORT_RE = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;

/**
 * Resolves a relative import specifier to a concrete file path. This repo's
 * `lib/*.mjs` modules always import with an explicit `.mjs` extension (no
 * bundler resolution step exists here — see design.md Decision 1), so no
 * extension-guessing is needed.
 */
function resolveRelativeImport(fromFile, specifier) {
  return resolve(dirname(fromFile), specifier);
}

/**
 * Walks the transitive import graph starting at `entryPath`, following only
 * relative specifiers (`./`, `../`) — bare specifiers (`node:fs`, npm
 * packages) have no local source to inspect and, by construction, cannot
 * contain a `client.mcp.*` call site this repo owns. Returns a Map of
 * absolute path -> source text for every visited module.
 */
function collectModuleGraph(entryPath) {
  const visited = new Map();
  const queue = [entryPath];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;

    const source = readFileSync(current, 'utf8');
    visited.set(current, source);

    IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(resolveRelativeImport(current, specifier));
      }
    }
  }

  return visited;
}

test('lib/mcp-valve.mjs and its transitive imports never reference a client.mcp SDK call site', () => {
  const graph = collectModuleGraph(ENTRY);

  // Sanity: the graph must contain more than just the entry file, otherwise
  // this assertion would trivially pass without checking anything real.
  assert.ok(graph.size >= 2, 'expected mcp-valve.mjs to import at least one other lib module');

  const FORBIDDEN = [/client\.mcp\.connect/, /client\.mcp\.disconnect/, /client\.mcp\.status/];

  for (const [path, source] of graph) {
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(source, pattern, `${path} must not reference ${pattern} — Decision 8's firewall`);
    }
  }
});

test('lib/mcp-valve.mjs imports only mcp-snapshot.mjs, mcp-usage.mjs, and sanitizeServerName from mcp-config.mjs', () => {
  const source = readFileSync(ENTRY, 'utf8');

  IMPORT_RE.lastIndex = 0;
  const relativeSpecifiers = [...source.matchAll(IMPORT_RE)]
    .map((m) => m[1])
    .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'));

  assert.ok(relativeSpecifiers.length > 0, 'expected at least one relative import');

  for (const specifier of relativeSpecifiers) {
    assert.ok(
      specifier.includes('mcp-snapshot') || specifier.includes('mcp-usage') || specifier.includes('mcp-config'),
      `unexpected import "${specifier}" in lib/mcp-valve.mjs — only mcp-snapshot.mjs, mcp-usage.mjs, and mcp-config.mjs are allowed`,
    );
  }

  // The ONLY named import allowed from mcp-config.mjs is sanitizeServerName —
  // mcp-config.mjs also exports readDeclaredMcpServers, which spawns a child
  // process; mcp-valve.mjs must never pull that in.
  const configImportLine = source
    .split('\n')
    .find((line) => line.includes("from '") && line.includes('mcp-config.mjs'));
  if (configImportLine !== undefined) {
    assert.match(configImportLine, /\bsanitizeServerName\b/, 'mcp-valve.mjs must import sanitizeServerName specifically');
    assert.doesNotMatch(
      configImportLine,
      /\breadDeclaredMcpServers\b/,
      'mcp-valve.mjs must not import readDeclaredMcpServers (it spawns a child process)',
    );
  }
});

test('no exported function in lib/mcp-valve.mjs takes a client parameter', () => {
  const source = readFileSync(ENTRY, 'utf8');
  const exportedFnRe = /export\s+function\s+\w+\s*\(([^)]*)\)/g;

  let match;
  let foundAny = false;
  while ((match = exportedFnRe.exec(source)) !== null) {
    foundAny = true;
    assert.doesNotMatch(
      match[1],
      /\bclient\b/,
      `exported function signature must not take a client parameter: (${match[1]})`,
    );
  }
  assert.ok(foundAny, 'expected at least one exported function in lib/mcp-valve.mjs to check');
});
