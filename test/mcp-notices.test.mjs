// test/mcp-notices.test.mjs
//
// Unit tests for lib/mcp-notices.mjs — the words the user actually reads.
//
// Comments and identifiers are English like every other lib module; the
// notice STRINGS are Spanish, matching the plugin's existing user-facing
// text (`summarizeMcpStatus` already emits "MCP actual (SDK): ...").
//
// Two rules dominate this file:
//
//   1. Silence when nothing happened. A notifier that speaks on every poll
//      is a notifier the user turns off, and then the one notice that
//      mattered is the one they never see.
//   2. Never state a count we could not read. "0 desconectados" and "no
//      pudimos leer el estado" are different sentences, and only one of them
//      is a fact.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startupNotice, transitionNotice } from '../lib/mcp-notices.mjs';

test('everything connected at startup produces NO notice — nothing happened worth interrupting for', () => {
  const notice = startupNotice({
    partition: { status: 'known', connected: ['engram', 'context7'], notConnected: [] },
    plan: { action: 'nothing-to-do', preserved: [], unmatchedProtections: [] },
  });

  assert.equal(notice, null);
});

test('starting with servers disconnected says HOW MANY and WHICH', () => {
  const notice = startupNotice({
    partition: { status: 'known', connected: ['engram'], notConnected: ['context7', 'otro'] },
    plan: { action: 'disable', targets: ['context7', 'otro'], preserved: ['engram'], unmatchedProtections: [] },
  });

  assert.ok(notice, 'a session starting with MCPs off is exactly what the user asked to be told');
  assert.match(notice.message, /2/, 'the count must be there');
  assert.match(notice.message, /context7/);
  assert.match(notice.message, /otro/);
});

test('a REFUSED plan is announced loudly, with its reason — this is the safety event', () => {
  const notice = startupNotice({
    partition: { status: 'known', connected: ['engram'], notConnected: [] },
    plan: { action: 'refuse', reason: 'protection-unknown', protectionReason: 'malformed-json' },
  });

  assert.ok(notice, 'refusing to act must never be silent: the user configured something that did not apply');
  assert.equal(notice.variant, 'warning', 'a refusal is not an informational aside');
  assert.match(notice.message, /malformed-json/, 'the user cannot fix a config error we will not name');
});

test('an unreadable status never becomes "0 desconectados"', () => {
  const notice = startupNotice({
    partition: { status: 'unreadable' },
    plan: { action: 'nothing-to-do', preserved: [], unmatchedProtections: [] },
  });

  assert.ok(notice, 'not being able to read the MCP state is itself worth saying');
  assert.doesNotMatch(notice.message, /\b0\b/, 'a count we could not take must not be printed as zero');
});

test('a protected name matching no live server is surfaced — it is what a typo looks like', () => {
  const notice = startupNotice({
    partition: { status: 'known', connected: ['engram'], notConnected: [] },
    plan: { action: 'nothing-to-do', preserved: ['engram'], unmatchedProtections: ['typo-server'] },
  });

  assert.ok(notice);
  assert.match(notice.message, /typo-server/);
});

test('a baseline reading produces no transition notice', () => {
  const notice = transitionNotice({ status: 'baseline', connected: [], disconnected: [], appeared: [], vanished: [] });

  assert.equal(notice, null, 'the first look at the world is not news');
});

test('a comparison with no movement produces no notice — this runs on every poll', () => {
  const notice = transitionNotice({ status: 'compared', connected: [], disconnected: [], appeared: [], vanished: [] });

  assert.equal(notice, null);
});

test('servers reaching connected are named', () => {
  const notice = transitionNotice({
    status: 'compared',
    connected: ['engram', 'context7'],
    disconnected: [],
    appeared: [],
    vanished: [],
  });

  assert.ok(notice);
  assert.match(notice.message, /engram/);
  assert.match(notice.message, /context7/);
});

test('connections and disconnections in the same poll are both reported, never one silently dropped', () => {
  const notice = transitionNotice({
    status: 'compared',
    connected: ['llega'],
    disconnected: ['se-va'],
    appeared: [],
    vanished: [],
  });

  assert.match(notice.message, /llega/);
  assert.match(notice.message, /se-va/);
});

test('an APPEARED server is never worded as having just connected', () => {
  const notice = transitionNotice({
    status: 'compared',
    connected: [],
    disconnected: [],
    appeared: [{ name: 'nuevo', connected: true }],
    vanished: [],
  });

  assert.ok(notice, 'a server showing up for the first time is still worth a word');
  assert.doesNotMatch(
    notice.message,
    /se ha conectado|se han conectado/,
    'we never watched it transition — saying so would invent an observation',
  );
  assert.match(notice.message, /nuevo/);
});

test('an unreadable diff produces no notice rather than a confident one', () => {
  const notice = transitionNotice({ status: 'unreadable', connected: [], disconnected: [], appeared: [], vanished: [] });

  assert.equal(notice, null);
});
