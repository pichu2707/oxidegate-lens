// test/mcp-transitions.test.mjs
//
// Unit tests for lib/mcp-transitions.mjs — turning two `client.mcp.status`
// readings into "what changed".
//
// This module exists because OpenCode emits NO MCP event. The full `Event`
// union in @opencode-ai/sdk (32 members: session, message, LSP, PTY, file,
// permission, TUI, PTY, server) contains nothing MCP-shaped, so "a server
// connected" can only be learned by reading the status twice and comparing.
// Verified by grep against the installed SDK's types.gen.d.ts, not assumed.
//
// The load-bearing test here is `the_first_reading_is_a_baseline`. Diffing
// against "nothing" trivially makes every connected server look like it just
// connected, which would fire a wave of false notices on every single
// startup — the exact noise that trains a user to ignore the feature.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffMcpStatus, partitionByConnected } from '../lib/mcp-transitions.mjs';

const status = (entries) => Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { status: v }]));

test('the first reading is a BASELINE, not a wave of connections', () => {
  const result = diffMcpStatus(undefined, status({ engram: 'connected', context7: 'connected' }));

  assert.equal(result.status, 'baseline');
  assert.deepEqual(result.connected, [], 'nothing "just connected" — we simply had not looked before');
  assert.deepEqual(result.disconnected, []);
  assert.deepEqual(result.appeared, [], 'a first sighting is not an appearance either');
});

test('a server leaving "connected" is reported as disconnected, whatever the new word is', () => {
  // The live SDK returns "disabled", NOT "disconnected", after
  // client.mcp.disconnect. Confirmed against a running OpenCode. This module
  // must never compare against a list of known "off" words.
  const before = status({ engram: 'connected', context7: 'connected' });
  const after = status({ engram: 'connected', context7: 'disabled' });

  const result = diffMcpStatus(before, after);
  assert.equal(result.status, 'compared');
  assert.deepEqual(result.disconnected, ['context7']);
  assert.deepEqual(result.connected, []);
});

test('an unrecognised status word counts as NOT connected — a false alarm beats silence about a real outage', () => {
  const before = status({ engram: 'connected' });
  const after = status({ engram: 'reticulating-splines' });

  const result = diffMcpStatus(before, after);
  assert.deepEqual(result.disconnected, ['engram']);
});

test('a server reaching "connected" is reported as connected', () => {
  const result = diffMcpStatus(status({ engram: 'disabled' }), status({ engram: 'connected' }));

  assert.equal(result.status, 'compared');
  assert.deepEqual(result.connected, ['engram']);
  assert.deepEqual(result.disconnected, []);
});

test('servers that did not move produce nothing at all', () => {
  const same = status({ engram: 'connected', context7: 'disabled' });
  const result = diffMcpStatus(same, { ...same });

  assert.deepEqual(result.connected, []);
  assert.deepEqual(result.disconnected, []);
  assert.deepEqual(result.appeared, []);
  assert.deepEqual(result.vanished, []);
});

test('a server we have never seen is APPEARED, not connected — even when it shows up already connected', () => {
  const result = diffMcpStatus(status({ engram: 'connected' }), status({ engram: 'connected', nuevo: 'connected' }));

  // Reporting this as "nuevo just connected" would claim we watched it
  // transition. We did not: it was not in the previous reading at all, so we
  // have no idea whether it was connected a second ago or an hour ago.
  assert.deepEqual(result.connected, [], 'never claim a transition we did not observe');
  assert.deepEqual(result.appeared, [{ name: 'nuevo', connected: true }]);
});

test('a server that disappears from the reading is VANISHED, not disconnected', () => {
  const result = diffMcpStatus(status({ engram: 'connected', gone: 'connected' }), status({ engram: 'connected' }));

  assert.deepEqual(result.vanished, ['gone']);
  assert.deepEqual(result.disconnected, [], 'removed from config is a different fact than turned off');
});

test('a malformed reading never throws and never invents transitions', () => {
  for (const junk of [null, 'nope', 42, [], { engram: 'not-an-object' }]) {
    const result = diffMcpStatus(status({ engram: 'connected' }), junk);
    assert.equal(typeof result, 'object', `must survive ${JSON.stringify(junk)}`);
    assert.equal(result.status, 'unreadable', `an unusable reading is not a comparison: ${JSON.stringify(junk)}`);
    assert.deepEqual(result.connected, []);
    assert.deepEqual(result.disconnected, []);
  }
});

test('partitionByConnected splits a reading for the startup notice', () => {
  const result = partitionByConnected(status({ a: 'connected', b: 'disabled', c: 'connected' }));

  assert.deepEqual(result.connected, ['a', 'c']);
  assert.deepEqual(result.notConnected, ['b']);
});

test('partitionByConnected on an unreadable status yields neither list, not two empty ones', () => {
  const result = partitionByConnected(null);

  // Two empty lists would render as "0 connected, 0 disconnected", a
  // confident statement about a reading we could not make.
  assert.equal(result.status, 'unreadable');
  assert.equal(result.connected, undefined);
  assert.equal(result.notConnected, undefined);
});
