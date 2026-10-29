// test/mcp-connect-description.test.mjs
//
// The model can only call oxidegate_lens_mcp_connect on its own if the tool
// tells it WHICH servers are disconnected and what each one offers. A
// disconnected server's tools are absent from the request, so this description
// is the model's only hint that a capability exists. The text is sent on every
// request, so it also has to stay small.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectDescription, DISCONNECT_DESCRIPTION, VALVE_DESCRIPTION } from '../lib/mcp-connect-description.mjs';

const known = (servers) => ({ status: 'known', freshness: 'fresh', timestamp: 't', servers });
const srv = (name, toolNames) => ({ name, price: { status: 'known', bytes: 1 }, toolNames });

test('lists each disconnected server with its tool names, and nothing about connected ones', () => {
  const text = buildConnectDescription({
    status: { engram: { status: 'connected' }, context7: { status: 'disabled' }, codegraph: { status: 'disabled' } },
    snapshot: known([srv('engram', ['mem_save']), srv('context7', ['resolve-library-id', 'query-docs']), srv('codegraph', ['codegraph_explore'])]),
  });
  assert.match(text, /context7: resolve-library-id, query-docs/);
  assert.match(text, /codegraph: codegraph_explore/);
  assert.ok(!text.includes('mem_save') && !/engram/.test(text), 'connected servers are not advertised');
});

test('tells the model to connect BEFORE it needs a capability only that server provides', () => {
  const text = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: known([srv('a', ['t'])]) });
  assert.match(text, /before/i);
  assert.match(text, /not available until/i);
});

test('unknown tool names are said to be unknown, never rendered as an empty list (absent is never zero)', () => {
  const noNames = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: known([srv('a', undefined)]) });
  assert.match(noNames, /a: tools unknown/);
  const notInSnapshot = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: known([]) });
  assert.match(notInSnapshot, /a: tools unknown/);
  const noSnapshot = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: { status: 'unknown', reason: 'missing-file' } });
  assert.match(noSnapshot, /a: tools unknown/);
  for (const t of [noNames, notInSnapshot, noSnapshot]) assert.ok(!/a: *(\[\]|none|0)/.test(t));
});

test('a server declaring zero tools says so explicitly (a different claim from unknown)', () => {
  const text = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: known([srv('a', [])]) });
  assert.match(text, /a: no tools declared/);
});

test('an empty tool list from a server that could not be measured is unknown, not "no tools declared"', () => {
  // mcp-savings records `tools: []` with price cannot-measure when the server was down at measurement time.
  const unmeasured = { name: 'a', price: { status: 'unknown', reason: 'cannot-measure' }, toolNames: [] };
  const text = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: known([unmeasured]) });
  assert.match(text, /a: tools unknown/);
  assert.ok(!/no tools declared/.test(text));
});

test('failed servers are offered (connecting retries them) and flagged; needs_auth and pending are not', () => {
  const text = buildConnectDescription({
    status: { f: { status: 'failed', error: 'x' }, n: { status: 'needs_auth' }, p: { status: 'pending' }, d: { status: 'disabled' } },
    snapshot: known([srv('f', ['ft']), srv('n', ['nt']), srv('p', ['pt']), srv('d', ['dt'])]),
  });
  assert.match(text, /f \(failed\): ft/);
  assert.match(text, /d: dt/);
  assert.ok(!/\bn:|: nt\b|\bp:|: pt\b/.test(text));
});

test('nothing disconnected -> says so briefly, still a valid manual-connect description', () => {
  const text = buildConnectDescription({ status: { a: { status: 'connected' } }, snapshot: known([srv('a', ['t'])]) });
  assert.match(text, /no disconnected/i);
  assert.ok(text.length < 600, `length=${text.length}`);
});

test('unreadable status is stated, not read as "nothing disconnected"', () => {
  const text = buildConnectDescription({ status: null, snapshot: known([]) });
  assert.match(text, /status unknown/i);
  assert.ok(!/no disconnected/i.test(text));
});

test('long tool lists are truncated per server with an honest count', () => {
  const many = Array.from({ length: 22 }, (_, i) => `tool_${i}`);
  const text = buildConnectDescription({ status: { big: { status: 'disabled' } }, snapshot: known([srv('big', many)]) });
  assert.match(text, /tool_0/);
  assert.match(text, /\(\+18 more\)/);
  assert.ok(!text.includes('tool_21'));
});

test('ten disconnected servers stay under the hard cap, and the overflow is counted and points at the valve', () => {
  const names = Array.from({ length: 10 }, (_, i) => `server_${String(i).padStart(2, '0')}`);
  const status = Object.fromEntries(names.map((n) => [n, { status: 'disabled' }]));
  const snapshot = known(names.map((n) => srv(n, Array.from({ length: 12 }, (_, i) => `${n}_tool_${i}_with_a_long_name`))));
  const text = buildConnectDescription({ status, snapshot });
  assert.ok(Buffer.byteLength(text) <= 1500, `bytes=${Buffer.byteLength(text)}`);
  const shown = names.filter((n) => text.includes(`${n}:`));
  assert.ok(shown.length >= 1 && shown.length < 10, 'some, not all, fit');
  const rest = 10 - shown.length;
  assert.match(text, new RegExp(`and ${rest} more, call oxidegate_lens_mcp_valve to list`));
  // the ones shown are the first in name order, never a random subset
  assert.deepEqual(shown, names.slice(0, shown.length));
});

test('every server gets its own single line entry (one name per entry, no schemas)', () => {
  const names = ['a', 'b', 'c'];
  const text = buildConnectDescription({
    status: Object.fromEntries(names.map((n) => [n, { status: 'disabled' }])),
    snapshot: known(names.map((n) => srv(n, ['x']))),
  });
  assert.ok(!text.includes('\n'));
  assert.ok(!/and \d+ more/.test(text), 'no overflow note when everything fits');
});

test('deterministic: servers are listed in name order', () => {
  const text = buildConnectDescription({
    status: { z: { status: 'disabled' }, a: { status: 'disabled' } },
    snapshot: known([srv('z', ['zt']), srv('a', ['at'])]),
  });
  assert.ok(text.indexOf('a: at') < text.indexOf('z: zt'));
});

test('disconnect/valve descriptions are not framed as test-only and point at the connect tool', () => {
  for (const d of [DISCONNECT_DESCRIPTION, VALVE_DESCRIPTION]) {
    assert.ok(!/manual(ly)? .*test|before manual MCP valve tests/i.test(d), d);
  }
  assert.match(DISCONNECT_DESCRIPTION, /oxidegate_lens_mcp_connect/);
  assert.match(DISCONNECT_DESCRIPTION, /no longer need|free/i);
});

test('connect warns that changing the tool list mid-conversation breaks the prompt cache, so connect once and early', () => {
  const text = buildConnectDescription({ status: { a: { status: 'disabled' } }, snapshot: known([srv('a', ['t'])]) });
  assert.match(text, /prompt cache/i);
  assert.match(text, /once/i);
  assert.match(text, /early/i);
  assert.ok(!/\d+(\.\d+)?\s*x\b|\$/i.test(text), 'no invented prices');
});

test('disconnect warns that doing it mid-conversation re-sends the history uncached; only at session start or on request', () => {
  assert.match(DISCONNECT_DESCRIPTION, /prompt cache/i);
  assert.match(DISCONNECT_DESCRIPTION, /uncached/i);
  assert.match(DISCONNECT_DESCRIPTION, /start of a session/i);
  assert.match(DISCONNECT_DESCRIPTION, /user (explicitly )?asks/i);
});

test('valve does not suggest toggling servers without the cache caveat', () => {
  assert.match(VALVE_DESCRIPTION, /prompt cache/i);
});

test('the cache note never pushes any variant past the hard cap', () => {
  const names = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, '0')}`);
  const status = Object.fromEntries(names.map((n) => [n, { status: 'disabled' }]));
  const text = buildConnectDescription({ status, snapshot: known(names.map((n) => srv(n, ['a_long_tool_name_here', 'b', 'c', 'd', 'e']))) });
  assert.ok(Buffer.byteLength(text) <= 1500, `bytes=${Buffer.byteLength(text)}`);
  assert.match(text, /prompt cache/i);
});
