// test/mcp-snapshot.test.mjs
//
// Unit tests for lib/mcp-snapshot.mjs's HONESTY INVARIANT: an absent
// measurement is never a zero measurement. See the module's own header
// comment for the full contract these tests hold it to.
//
// Load-bearing pair: 'ok:false + bytes:0' vs 'ok:true + bytes:0' proves the
// module's guard reads the `ok` FLAG, not the mere presence of `.bytes` —
// a field-presence check would pass both through as `known: 0`, which is
// exactly the fabricated-zero bug Decision 4 forbids.
//
// Hermetic: every fixture is written to a throwaway temp file via
// `path` injection. `readMcpSavingsSnapshot` never touches the real
// `~/.config/mcp-savings/snapshot.json` in these tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMcpSavingsSnapshot } from '../lib/mcp-snapshot.mjs';

const HOUR_MS = 60 * 60 * 1000;

/** Writes `content` (string) to a throwaway temp file; cleans up via t.after. */
async function writeSnapshotFixture(t, content) {
  const dir = await mkdtemp(join(tmpdir(), 'oxidegate-lens-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, content);
  return path;
}

test('readMcpSavingsSnapshot: missing file -> unknown/missing-file, never throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oxidegate-lens-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'does-not-exist.json');

  const result = readMcpSavingsSnapshot({ path, now: Date.now() });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'missing-file');
});

test('readMcpSavingsSnapshot: malformed JSON -> unknown/malformed-json, never throws', async (t) => {
  const path = await writeSnapshotFixture(t, '{ this is not valid JSON ');

  const result = readMcpSavingsSnapshot({ path, now: Date.now() });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'malformed-json');
});

test('readMcpSavingsSnapshot: torn JSON (partial write, truncated mid-object) -> unknown/malformed-json', async (t) => {
  // Simulates saveSnapshot's non-atomic writeFileSync caught mid-write —
  // see design.md "What the code already tells us": saveSnapshot is not
  // atomic, so torn reads are structurally possible.
  const torn = JSON.stringify({
    timestamp: Date.now(),
    mcpMeasurement: [{ server: 'engram', bytes: 1234 }],
  }).slice(0, 30);
  const path = await writeSnapshotFixture(t, torn);

  const result = readMcpSavingsSnapshot({ path, now: Date.now() });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'malformed-json');
});

test('readMcpSavingsSnapshot: entry missing bytes -> that entry price unknown, snapshot still known', async (t) => {
  const now = Date.now();
  const path = await writeSnapshotFixture(
    t,
    JSON.stringify({
      timestamp: now,
      mcpMeasurement: [{ server: 'no-bytes-server' }],
    }),
  );

  const result = readMcpSavingsSnapshot({ path, now });
  assert.equal(result.status, 'known');
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].name, 'no-bytes-server');
  assert.equal(result.servers[0].price.status, 'unknown');
});

test('readMcpSavingsSnapshot: ok:false + bytes:0 -> price unknown, bytes discarded (never a fabricated 0)', async (t) => {
  const now = Date.now();
  const path = await writeSnapshotFixture(
    t,
    JSON.stringify({
      timestamp: now,
      mcpMeasurement: [{ server: 'broken-server', ok: false, bytes: 0 }],
    }),
  );

  const result = readMcpSavingsSnapshot({ path, now });
  assert.equal(result.status, 'known');
  const [entry] = result.servers;
  assert.equal(entry.price.status, 'unknown');
  assert.notEqual(entry.price.status, 'known');
  assert.equal(entry.price.bytes, undefined);
});

test('readMcpSavingsSnapshot: ok:true + bytes:0 -> price known 0, a genuine zero (proves the guard reads `ok`, not presence)', async (t) => {
  const now = Date.now();
  const path = await writeSnapshotFixture(
    t,
    JSON.stringify({
      timestamp: now,
      mcpMeasurement: [{ server: 'empty-tools-server', ok: true, bytes: 0 }],
    }),
  );

  const result = readMcpSavingsSnapshot({ path, now });
  assert.equal(result.status, 'known');
  const [entry] = result.servers;
  assert.equal(entry.price.status, 'known');
  assert.equal(entry.price.bytes, 0);
});

test('readMcpSavingsSnapshot: tokens:null passes through unchanged (never coerced to 0)', async (t) => {
  const now = Date.now();
  const path = await writeSnapshotFixture(
    t,
    JSON.stringify({
      timestamp: now,
      mcpMeasurement: [{ server: 'claude-model-server', bytes: 500, tokens: null }],
    }),
  );

  const result = readMcpSavingsSnapshot({ path, now });
  const [entry] = result.servers;
  assert.equal(entry.tokens, null);
  assert.notEqual(entry.tokens, 0);
});

test('readMcpSavingsSnapshot: fresh snapshot (well within 24h) -> freshness "fresh"', async (t) => {
  const now = Date.now();
  const path = await writeSnapshotFixture(
    t,
    JSON.stringify({
      timestamp: now - 1 * HOUR_MS,
      mcpMeasurement: [],
    }),
  );

  const result = readMcpSavingsSnapshot({ path, now });
  assert.equal(result.status, 'known');
  assert.equal(result.freshness, 'fresh');
});

test('readMcpSavingsSnapshot: 30h-old snapshot -> freshness "stale" (24h threshold), price still renders', async (t) => {
  const now = Date.now();
  const path = await writeSnapshotFixture(
    t,
    JSON.stringify({
      timestamp: now - 30 * HOUR_MS,
      mcpMeasurement: [{ server: 'stale-priced-server', bytes: 999 }],
    }),
  );

  const result = readMcpSavingsSnapshot({ path, now });
  assert.equal(result.status, 'known');
  assert.equal(result.freshness, 'stale');
  // Stale price data MUST still render, tagged with its timestamp.
  assert.equal(result.servers[0].price.status, 'known');
  assert.equal(result.servers[0].price.bytes, 999);
  assert.equal(result.timestamp, now - 30 * HOUR_MS);
});

test('readMcpSavingsSnapshot: valid JSON but not the expected shape -> unknown/unrecognized-shape', async (t) => {
  // Parses cleanly, but a bare `null`, a bare number, or an object with no
  // numeric `timestamp` is not a snapshot. Spec: "unrecognized shape MUST
  // degrade" — never throw, never pretend it is a known snapshot.
  const now = Date.now();
  for (const content of ['null', '42', '{}', JSON.stringify({ timestamp: '2020-01-01' })]) {
    const path = await writeSnapshotFixture(t, content);
    const result = readMcpSavingsSnapshot({ path, now });
    assert.equal(result.status, 'unknown', `content ${content} should be unknown`);
    assert.equal(result.reason, 'unrecognized-shape', `content ${content} reason`);
  }
});

test('readMcpSavingsSnapshot: path exists but is unreadable as a file -> unknown/unreadable', async (t) => {
  // A path that exists but cannot be read as a file (here: it IS a
  // directory, so readFileSync throws EISDIR, not ENOENT) must degrade to
  // `unreadable` — distinct from `missing-file` — and never throw.
  const dir = await mkdtemp(join(tmpdir(), 'oxidegate-lens-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = readMcpSavingsSnapshot({ path: dir, now: Date.now() });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unreadable');
});
