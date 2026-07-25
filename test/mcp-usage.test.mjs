// test/mcp-usage.test.mjs
//
// Unit tests for lib/mcp-usage.mjs's confidence gate and window derivation.
// See the module's own header comment for the full contract these tests
// hold it to: the window is DERIVED from the payload's own timestamps
// (never a wall clock, never an assumed uptime — design.md Decision 2), and
// the two-part sufficiency gate (design.md Decision 3) refuses to emit a
// recommendation-bearing observation the sample cannot support.
//
// Hermetic: every fixture is an in-memory `RecentRequest[]` array. No
// filesystem, no network, no real clock — `now` (where accepted) is always
// injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeMcpUsage } from '../lib/mcp-usage.mjs';

const MINUTE_MS = 60 * 1000;

/** Builds a minimal RecentRequest fixture. */
function request({ timestamp, toolsByServer }) {
  return { timestamp, tools_by_server: toolsByServer };
}

/** ISO-8601 / RFC 3339 timestamp `minutesAgo` minutes before `baseMs`. */
function isoMinutesBefore(baseMs, minutesAgo) {
  return new Date(baseMs - minutesAgo * MINUTE_MS).toISOString();
}

/** N requests evenly spread across `spanMinutes`, each with one `mcp` entry so they count as valid evidence. */
function spreadRequests(baseMs, spanMinutes, count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const minutesAgo = count === 1 ? 0 : spanMinutes - (spanMinutes * i) / (count - 1);
    rows.push(
      request({
        timestamp: isoMinutesBefore(baseMs, minutesAgo),
        toolsByServer: [{ server: 'engram', kind: 'mcp' }],
      }),
    );
  }
  return rows;
}

test('observeMcpUsage: window = newest timestamp - oldest timestamp', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = [
    request({ timestamp: isoMinutesBefore(now, 45), toolsByServer: [{ server: 'engram', kind: 'mcp' }] }),
    request({ timestamp: isoMinutesBefore(now, 0), toolsByServer: [{ server: 'engram', kind: 'mcp' }] }),
  ];

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.windowMs, 45 * MINUTE_MS);
});

test('observeMcpUsage: gate REFUSES at 29 min window / 4 requests', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 29, 4);

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'insufficient-observation');
  assert.equal(result.windowMs, 29 * MINUTE_MS);
  assert.equal(result.count, 4);
});

test('observeMcpUsage: gate PASSES at 30 min window / 5 requests', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 5);

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.windowMs, 30 * MINUTE_MS);
});

test('observeMcpUsage: gate is a CONJUNCTION — 30 min window but only 4 requests still REFUSES', () => {
  // Proves the two gates are orthogonal (design.md Decision 3): plenty of
  // time observed, not enough evidence.
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 4);

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'insufficient-observation');
  assert.equal(result.count, 4);
});

test('observeMcpUsage: gate is a CONJUNCTION — 5 requests but only 29 min window still REFUSES', () => {
  // The inverse: plenty of evidence, not enough time — the burst case.
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 29, 5);

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'insufficient-observation');
  assert.equal(result.windowMs, 29 * MINUTE_MS);
});

test('observeMcpUsage: (others) flag is set when any row in the window carries an "others" bucket', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 5);
  // Overwrite one row's tools_by_server to include an overflow bucket.
  requests[2].tools_by_server = [
    { server: 'engram', kind: 'mcp' },
    { kind: 'others' },
  ];

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.hasOthersBucket, true);
});

test('observeMcpUsage: (others) flag is false when no row carries an "others" bucket', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 5);

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.hasOthersBucket, false);
});

test('observeMcpUsage: rows with ABSENT tools_by_server are EXCLUDED from window and count', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = [
    // No tools_by_server field at all — an OxideGate build predating it.
    // Not evidence of absence; must not shrink the window or count.
    { timestamp: isoMinutesBefore(now, 60) },
    ...spreadRequests(now, 30, 5),
  ];

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.windowMs, 30 * MINUTE_MS);
});

test('observeMcpUsage: rows with an EMPTY tools_by_server array are INCLUDED', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 4);
  // A real observation that a request declared no tools — counts as evidence.
  requests.push(request({ timestamp: isoMinutesBefore(now, 0), toolsByServer: [] }));

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.count, undefined); // count is only surfaced on the insufficient-observation branch
});

test('observeMcpUsage: a row with an unparseable RFC 3339 timestamp is DROPPED, not fatal', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = [
    request({ timestamp: 'not-a-real-timestamp', toolsByServer: [{ server: 'engram', kind: 'mcp' }] }),
    ...spreadRequests(now, 30, 5),
  ];

  assert.doesNotThrow(() => observeMcpUsage(requests, { now }));
  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.windowMs, 30 * MINUTE_MS);
});

test('observeMcpUsage: no requests at all -> insufficient-observation, windowMs 0, count 0, never throws', () => {
  assert.doesNotThrow(() => observeMcpUsage([], { now: Date.now() }));
  const result = observeMcpUsage([], { now: Date.now() });

  assert.equal(result.status, 'insufficient-observation');
  assert.equal(result.windowMs, 0);
  assert.equal(result.count, 0);
});

test('observeMcpUsage: usesByLabel counts occurrences per server label across the window', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 5); // 5 rows, each declaring 'engram' once
  requests[0].tools_by_server.push({ server: 'github', kind: 'mcp' });

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.usesByLabel.engram, 5);
  assert.equal(result.usesByLabel.github, 1);
});

test('observeMcpUsage: a native-kind entry is NOT counted as MCP usage', () => {
  // Contract lock: only `kind: 'mcp'` entries are MCP usage. A `native` tool
  // cannot be disabled via the MCP valve, so counting it as a server's usage
  // would silently corrupt the disable recommendation. The wire label on a
  // native row (here "builtin") must never appear in usesByLabel.
  const now = Date.parse('2026-07-18T12:00:00.000Z');
  const requests = spreadRequests(now, 30, 5);
  requests[0].tools_by_server.push({ server: 'builtin', kind: 'native' });

  const result = observeMcpUsage(requests, { now });

  assert.equal(result.status, 'observed');
  assert.equal(result.usesByLabel.engram, 5);
  assert.equal(result.usesByLabel.builtin, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(result.usesByLabel, 'builtin'), false);
  assert.equal(result.hasOthersBucket, false);
});
