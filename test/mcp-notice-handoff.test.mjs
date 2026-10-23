// test/mcp-notice-handoff.test.mjs
//
// The v2 server plugin cannot toast; the v2 TUI plugin can. They are separate
// plugins, so the one notice only the server can compose (the disable-by-
// default startup notice, which depends on its plan) travels through a small
// file, the same way mcp-savings hands its snapshot from server to TUI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHandoffPath, writeStartupNotice, readFreshStartupNotice } from '../lib/mcp-notice-handoff.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'lens-handoff-')), 'nested', 'startup-notice.json');
const notice = { title: 'T', message: 'm', variant: 'info' };

test('resolveHandoffPath: XDG_STATE_HOME wins, then ~/.local/state, always under oxidegate-lens/', () => {
  assert.equal(resolveHandoffPath({ XDG_STATE_HOME: '/s' }), '/s/oxidegate-lens/startup-notice.json');
  assert.equal(resolveHandoffPath({ HOME: '/h' }), '/h/.local/state/oxidegate-lens/startup-notice.json');
});

test('write then read: a fresh notice comes back with its id; creates missing directories', () => {
  const path = tmp();
  const id = writeStartupNotice({ path, notice, now: 1000 });
  assert.equal(typeof id, 'string');
  assert.deepEqual(readFreshStartupNotice({ path, now: 2000, maxAgeMs: 60_000 }), { id, notice });
});

test('read: stale, already-seen, missing, malformed or notice-less files all return null (silence, never a fabricated notice)', () => {
  const path = tmp();
  assert.equal(readFreshStartupNotice({ path, now: 1, maxAgeMs: 10 }), null, 'missing file');
  const id = writeStartupNotice({ path, notice, now: 1000 });
  assert.equal(readFreshStartupNotice({ path, now: 1000 + 61_000, maxAgeMs: 60_000 }), null, 'stale');
  assert.equal(readFreshStartupNotice({ path, now: 1500, maxAgeMs: 60_000, seenId: id }), null, 'already shown');
  writeFileSync(path, '{not json');
  assert.equal(readFreshStartupNotice({ path, now: 1500, maxAgeMs: 60_000 }), null, 'malformed');
  writeFileSync(path, JSON.stringify({ id: 'x', at: 1400 }));
  assert.equal(readFreshStartupNotice({ path, now: 1500, maxAgeMs: 60_000 }), null, 'no notice field');
});

test('write: a null notice removes nothing and writes nothing (no notice stays no notice)', () => {
  const path = tmp();
  assert.equal(writeStartupNotice({ path, notice: null, now: 1 }), null);
  assert.equal(existsSync(path), false);
});

test('write: an unwritable path never throws (best-effort channel)', () => {
  assert.equal(writeStartupNotice({ path: '/proc/definitely/not/writable/x.json', notice, now: 1 }), null);
});
