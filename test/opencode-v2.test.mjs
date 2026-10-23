// test/opencode-v2.test.mjs
//
// Unit tests for lib/opencode-v2.mjs: the pure adapters between OpenCode 2.x's
// plugin API and the status/notice shapes the rest of lib/ already speaks.
// The plugin entry itself (opencode/oxidegate-lens.server.ts) is TypeScript
// and cannot run under `node --test`, so everything decidable lives here and
// the entry stays a thin adapter (design.md Decision 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mcpListToStatus,
  applyMcpOverrides,
  isMcpStatusChangedEvent,
  noticeToLogLine,
  mcpToolInput,
  overridesSettled,
  waitUntilSettled,
  planSwitch,
  toastFromNotice,
  V2_DEGRADATIONS,
  summarizeMcpStatus,
  valveResult,
  latestRequestLine,
  resolveBaseUrl,
} from '../lib/opencode-v2.mjs';
import { diffMcpStatus, partitionByConnected } from '../lib/mcp-transitions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- status

test('mcpListToStatus: v2 tagged-union list -> the {name: {status}} record lib/ already consumes', () => {
  const status = mcpListToStatus([
    { name: 'a', status: { status: 'connected' } },
    { name: 'b', status: { status: 'failed', error: 'boom' } },
    { name: 'c', status: { status: 'pending' } },
  ]);
  assert.deepEqual(status, {
    a: { status: 'connected' },
    b: { status: 'failed', error: 'boom' },
    c: { status: 'pending' },
  });
});

test('mcpListToStatus: accepts the { location, data } envelope the list call may return', () => {
  const status = mcpListToStatus({ location: {}, data: [{ name: 'a', status: { status: 'disabled' } }] });
  assert.deepEqual(status, { a: { status: 'disabled' } });
});

test('mcpListToStatus: a plain-string status is tolerated', () => {
  assert.deepEqual(mcpListToStatus([{ name: 'a', status: 'connected' }]), { a: { status: 'connected' } });
});

test('mcpListToStatus: an empty list is a real, empty reading (not unreadable)', () => {
  assert.deepEqual(mcpListToStatus([]), {});
});

test('mcpListToStatus: anything unreadable is null, never an empty record (absent is never zero)', () => {
  for (const bad of [undefined, null, 'x', 5, {}, { data: 'x' }, [null], [{ status: { status: 'connected' } }], [{ name: 'a' }], [{ name: 'a', status: {} }]]) {
    assert.equal(mcpListToStatus(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('mcpListToStatus output feeds diffMcpStatus/partitionByConnected unchanged', () => {
  const before = mcpListToStatus([{ name: 'a', status: { status: 'connected' } }]);
  const after = mcpListToStatus([{ name: 'a', status: { status: 'disabled' } }]);
  assert.deepEqual(diffMcpStatus(before, after).disconnected, ['a']);
  assert.deepEqual(partitionByConnected(before), { status: 'known', connected: ['a'], notConnected: [] });
  // unreadable stays unreadable downstream
  assert.equal(diffMcpStatus(before, mcpListToStatus('x')).status, 'unreadable');
});

// ------------------------------------------------------------- overrides

function fakeEditor(initial) {
  const servers = new Map(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  return {
    servers,
    get: (name) => servers.get(name),
    update: (name, fn) => {
      const cfg = servers.get(name);
      if (cfg) fn(cfg);
    },
  };
}

test('applyMcpOverrides: sets disabled true/false on known servers and reports them', () => {
  const editor = fakeEditor({ a: { type: 'local' }, b: { type: 'remote', disabled: true } });
  const result = applyMcpOverrides(editor, new Map([['a', true], ['b', false]]));
  assert.equal(editor.servers.get('a').disabled, true);
  assert.equal(editor.servers.get('b').disabled, false);
  assert.deepEqual(result, { applied: ['a', 'b'], missing: [], previous: { a: undefined, b: true } });
});

test('applyMcpOverrides: an unknown server is reported missing and nothing is invented', () => {
  const editor = fakeEditor({ a: { type: 'local' } });
  const result = applyMcpOverrides(editor, { ghost: true });
  assert.deepEqual(result, { applied: [], missing: ['ghost'], previous: {} });
  assert.equal(editor.servers.has('ghost'), false);
});

test('applyMcpOverrides: no overrides touches nothing', () => {
  const editor = fakeEditor({ a: { type: 'local' } });
  assert.deepEqual(applyMcpOverrides(editor, new Map()), { applied: [], missing: [], previous: {} });
  assert.equal('disabled' in editor.servers.get('a'), false);
});

// -------------------------------------------------------------- settling

test('overridesSettled: true only when every overridden server shows the state it was asked for', () => {
  const status = { a: { status: 'disabled' }, b: { status: 'connected' }, c: { status: 'pending' } };
  assert.equal(overridesSettled(status, new Map([['a', true], ['b', false]])), true);
  assert.equal(overridesSettled(status, new Map([['b', true]])), false, 'still connected');
  assert.equal(overridesSettled(status, new Map([['a', false]])), false, 'still disabled');
  assert.equal(overridesSettled(status, new Map([['c', true]])), false, 'pending is not settled-disabled');
});

test('overridesSettled: re-enabled server counts as settled once it leaves disabled, even while pending', () => {
  assert.equal(overridesSettled({ a: { status: 'pending' } }, new Map([['a', false]])), true);
  assert.equal(overridesSettled({ a: { status: 'failed', error: 'x' } }, new Map([['a', false]])), true);
});

test('overridesSettled: unreadable status is never "settled"; no overrides trivially are; vanished servers are ignored', () => {
  assert.equal(overridesSettled(null, new Map([['a', true]])), false);
  assert.equal(overridesSettled(null, new Map()), true);
  assert.equal(overridesSettled({}, new Map([['gone', true]])), true);
});

// ------------------------------------------------------------ switch plan
//
// OpenCode's reconcile skips servers whose config is deep-equal to the one it
// last applied. When something else (the TUI /mcp dialog) changed the server's
// runtime state without touching config, re-applying the same override is a
// no-op and the server stays where the user left it. planSwitch spots that.

test('planSwitch: connect with a different config is a plain direct change', () => {
  assert.deepEqual(planSwitch({ action: 'connect', status: 'disabled', applied: true }), { mode: 'direct', disabled: false });
  assert.deepEqual(planSwitch({ action: 'connect', status: 'disabled', applied: undefined, base: undefined }), { mode: 'direct', disabled: false });
});

test('planSwitch: connect when config already says enabled but the server is down (TUI disconnect) -> toggle', () => {
  for (const status of ['disabled', 'failed', 'needs_auth']) {
    assert.deepEqual(planSwitch({ action: 'connect', status, applied: false }), { mode: 'toggle', disabled: false }, status);
  }
  assert.deepEqual(planSwitch({ action: 'connect', status: 'disabled', applied: undefined, base: false }), { mode: 'toggle', disabled: false });
});

test('planSwitch: connect on a server that is already connected or starting never toggles', () => {
  for (const status of ['connected', 'pending']) {
    assert.equal(planSwitch({ action: 'connect', status, applied: false }).mode, 'direct', status);
  }
});

test('planSwitch: disconnect when config already says disabled but the server is up (TUI connect) -> toggle', () => {
  for (const status of ['connected', 'pending', 'failed']) {
    assert.deepEqual(planSwitch({ action: 'disconnect', status, applied: true }), { mode: 'toggle', disabled: true }, status);
  }
  assert.deepEqual(planSwitch({ action: 'disconnect', status: 'connected', applied: undefined, base: true }), { mode: 'toggle', disabled: true });
});

test('planSwitch: disconnect of a server already disabled, or with a different config, is direct', () => {
  assert.equal(planSwitch({ action: 'disconnect', status: 'disabled', applied: true }).mode, 'direct');
  assert.equal(planSwitch({ action: 'disconnect', status: 'connected', applied: false }).mode, 'direct');
  assert.equal(planSwitch({ action: 'disconnect', status: 'connected', applied: undefined, base: undefined }).mode, 'direct');
});

test('planSwitch: unreadable status (undefined) is treated as not matching, so a stuck config still toggles', () => {
  assert.equal(planSwitch({ action: 'connect', status: undefined, applied: false }).mode, 'toggle');
});

test('applyMcpOverrides: reports the config value each server had before the override (for planSwitch)', () => {
  const editor = fakeEditor({ a: { type: 'local' }, b: { type: 'local', disabled: true } });
  const result = applyMcpOverrides(editor, new Map([['a', true], ['b', false]]));
  assert.deepEqual(result.previous, { a: undefined, b: true });
});

// ---------------------------------------------------- event-driven settle

function fakeBus() {
  const listeners = new Set();
  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: () => [...listeners].forEach((cb) => cb()),
    size: () => listeners.size,
  };
}

test('waitUntilSettled: already settled -> true after ONE check, without waiting for any event', async () => {
  const bus = fakeBus();
  let checks = 0;
  const ok = await waitUntilSettled({ check: async () => (checks++, true), subscribe: bus.subscribe, timeoutMs: 60_000 });
  assert.equal(ok, true);
  assert.equal(checks, 1);
  assert.equal(bus.size(), 0, 'unsubscribed');
});

test('waitUntilSettled: wakes on the event, not on a poll tick', async () => {
  const bus = fakeBus();
  let state = false;
  let checks = 0;
  const p = waitUntilSettled({ check: async () => (checks++, state), subscribe: bus.subscribe, timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(checks, 1, 'no polling while nothing changes');
  state = true;
  bus.emit();
  assert.equal(await p, true);
  assert.equal(checks, 2);
  assert.equal(bus.size(), 0);
});

test('waitUntilSettled: an event that lands DURING the check is not lost (no race)', async () => {
  const bus = fakeBus();
  let state = false;
  let checks = 0;
  const check = async () => {
    checks++;
    const seen = state; // reading happens first...
    if (checks === 1) {
      await new Promise((r) => setTimeout(r, 10));
      state = true; // ...then the world changes and announces it before check() resolves
      bus.emit();
    }
    return seen;
  };
  const ok = await waitUntilSettled({ check, subscribe: bus.subscribe, timeoutMs: 60_000 });
  assert.equal(ok, true);
  assert.equal(checks, 2);
});

test('waitUntilSettled: safety-net timeout returns false (honest), and still unsubscribes', async () => {
  const bus = fakeBus();
  const started = Date.now();
  const ok = await waitUntilSettled({ check: async () => false, subscribe: bus.subscribe, timeoutMs: 40 });
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(bus.size(), 0);
});

test('waitUntilSettled: events that do not settle keep waiting until the deadline', async () => {
  const bus = fakeBus();
  const p = waitUntilSettled({ check: async () => false, subscribe: bus.subscribe, timeoutMs: 60 });
  bus.emit();
  bus.emit();
  assert.equal(await p, false);
});

test('waitUntilSettled: a throwing check propagates and still unsubscribes', async () => {
  const bus = fakeBus();
  await assert.rejects(
    waitUntilSettled({ check: async () => { throw new Error('boom'); }, subscribe: bus.subscribe, timeoutMs: 1000 }),
    /boom/,
  );
  assert.equal(bus.size(), 0);
});

// ---------------------------------------------------------------- events

test('isMcpStatusChangedEvent: only mcp.status.changed qualifies', () => {
  assert.equal(isMcpStatusChangedEvent({ type: 'mcp.status.changed', data: { server: 'a' } }), true);
  for (const other of [{ type: 'mcp.tools.changed' }, { type: 'session.idle' }, {}, null, undefined, 'x']) {
    assert.equal(isMcpStatusChangedEvent(other), false);
  }
});

// --------------------------------------------------------------- notices

test('noticeToLogLine: null notice -> null (silence stays silence)', () => {
  assert.equal(noticeToLogLine(null), null);
  assert.equal(noticeToLogLine(undefined), null);
});

test('noticeToLogLine: warning goes to the warn level, everything else to log, always prefixed', () => {
  assert.deepEqual(noticeToLogLine({ title: 'T', message: 'm', variant: 'warning' }), {
    level: 'warn',
    text: '[oxidegate-lens] T: m',
  });
  assert.deepEqual(noticeToLogLine({ title: 'T', message: 'm', variant: 'info' }), {
    level: 'log',
    text: '[oxidegate-lens] T: m',
  });
});

test('toastFromNotice: same durations as the v1 toast (warnings stay longer); null stays null', () => {
  assert.equal(toastFromNotice(null), null);
  assert.deepEqual(toastFromNotice({ title: 'T', message: 'm', variant: 'warning' }), { title: 'T', message: 'm', variant: 'warning', duration: 10000 });
  assert.deepEqual(toastFromNotice({ title: 'T', message: 'm', variant: 'info' }), { title: 'T', message: 'm', variant: 'info', duration: 5000 });
});

// ----------------------------------------------------------------- tools

test('mcpToolInput: valve takes only optional provider/model', () => {
  const schema = mcpToolInput('valve');
  assert.equal(schema.type, 'object');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['model', 'provider']);
  assert.equal(schema.required, undefined);
});

test('mcpToolInput: connect/disconnect require a string server', () => {
  for (const kind of ['connect', 'disconnect']) {
    const schema = mcpToolInput(kind);
    assert.deepEqual(schema.required, ['server']);
    assert.equal(schema.properties.server.type, 'string');
    assert.ok('provider' in schema.properties && 'model' in schema.properties);
  }
});

test('mcpToolInput: an unknown kind throws rather than returning a permissive schema', () => {
  assert.throws(() => mcpToolInput('nope'));
});

// ---------------------------------------------------------- degradations

test('V2_DEGRADATIONS names every capability v2 cannot provide as v1 did', () => {
  const text = V2_DEGRADATIONS.join('\n');
  assert.ok(/toast/i.test(text), 'toast');
  assert.ok(/connect/i.test(text), 'connect/disconnect');
  assert.ok(/tool[ -]list|tool_count/i.test(text), 'provider/model tool list');
  assert.ok(Object.isFrozen(V2_DEGRADATIONS));
});

// ----------------------------------------------------- shared formatting

test('summarizeMcpStatus keeps the v1 wording; unreadable says unknown', () => {
  assert.equal(summarizeMcpStatus({ b: { status: 'disabled' }, a: { status: 'connected' } }), 'MCP actual (SDK): a=connected, b=disabled');
  assert.equal(summarizeMcpStatus(null), 'MCP actual: unknown');
  assert.equal(summarizeMcpStatus({}), 'MCP actual (SDK): none');
});

test('valveResult carries the caveat + the verbatim warning, and the caller fields win nothing over them', () => {
  const parsed = JSON.parse(valveResult({ ok: true, action: 'valve' }));
  assert.equal(parsed.caveat, 'oxidegate-lens manual OpenCode MCP valve');
  assert.equal(
    parsed.warning,
    'Manual runtime control only. This does not promise same-request lazy MCP behavior or outgoing tool-list mutation.',
  );
  assert.equal(parsed.ok, true);
});

test('latestRequestLine: last measured entry rendered; no measured entry -> null', () => {
  const requests = [
    { model: 'old', context_measured_bytes: 10, context_tax_ratio: 0.5, ttft_ms: 1000, cost_estimate_usd: 0.1 },
    { model: 'm', context_measured_bytes: 20, context_tax_ratio: 0.123, ttft_ms: 2500, cost_estimate_usd: 0.0123 },
    { model: 'unmeasured', context_measured_bytes: null },
  ];
  assert.equal(latestRequestLine(requests), '[oxidegate-lens] m  tax 12.3%  ttft 2.5s  $0.0123');
  assert.equal(latestRequestLine([{ context_measured_bytes: null }]), null);
  assert.equal(latestRequestLine([]), null);
  assert.equal(latestRequestLine('x'), null);
});

test('latestRequestLine: missing fields render "-", never zero', () => {
  assert.equal(latestRequestLine([{ context_measured_bytes: 5 }]), '[oxidegate-lens] -  tax -  ttft -  -');
});

test('resolveBaseUrl: URL override beats port beats default 8080', () => {
  assert.equal(resolveBaseUrl({}), 'http://127.0.0.1:8080');
  assert.equal(resolveBaseUrl({ OXIDEGATE_PORT: '8899' }), 'http://127.0.0.1:8899');
  assert.equal(resolveBaseUrl({ OXIDEGATE_PORT: '8899', OXIDEGATE_LENS_URL: 'http://x:1' }), 'http://x:1');
});

// ------------------------------------------------------ package contract

test('package.json: "." stays the v1 entry, "./server" is the distinct v2 entry', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.exports['.'], './opencode/oxidegate-lens.ts');
  assert.equal(pkg.exports['./server'], './opencode/oxidegate-lens.server.ts');
});

test('v2 entry: default-exports an id + setup definition, same three tool names, no v1 API calls', () => {
  const src = readFileSync(resolve(__dirname, '../opencode/oxidegate-lens.server.ts'), 'utf8');
  assert.match(src, /export default/);
  assert.match(src, /\bid:\s*'oxidegate-lens'/);
  assert.match(src, /\bsetup\b/);
  for (const name of ['oxidegate_lens_mcp_valve', 'oxidegate_lens_mcp_disconnect', 'oxidegate_lens_mcp_connect']) {
    assert.ok(src.includes(name), name);
  }
  assert.ok(!/client\.mcp\./.test(src), 'v2 has no SDK client; client.mcp.* belongs to the v1 entry');
  assert.ok(!src.includes('@opencode-ai/plugin'), 'v1 SDK package must not be imported by the v2 entry');
});

test('v2 entry: also carries the v1 `server` function, because OpenCode 1.x resolves "./server" too and demands default.server()', () => {
  const src = readFileSync(resolve(__dirname, '../opencode/oxidegate-lens.server.ts'), 'utf8');
  assert.match(src, /import \{ OxidegateLens \} from '\.\/oxidegate-lens\.ts'/, 'reuse the v1 plugin function, do not copy it');
  assert.match(src, /\bserver:\s*OxidegateLens\b/, 'v1 reads default.server');
});

test('package.json: "./tui" is the TUI entry; no @opentui/solid-js in regular dependencies (host provides them)', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.exports['./tui'], './opencode/oxidegate-lens.tui.ts');
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(!/^@opentui\/|^solid-js$/.test(name), `${name} must not be a regular dependency`);
  }
});

test('TUI entry: default-exports { id, setup }, toasts through ctx.ui.toast, imports no opentui/solid', () => {
  const src = readFileSync(resolve(__dirname, '../opencode/oxidegate-lens.tui.ts'), 'utf8');
  assert.match(src, /export default/);
  assert.match(src, /\bid:\s*'oxidegate-lens\.tui'/);
  assert.match(src, /ctx\.ui\.toast\.show/);
  assert.match(src, /mcp\.status\.changed/);
  assert.ok(!/from '@opentui|from 'solid-js|@opencode\/plugin/.test(src), 'no runtime imports from host-provided packages');
});
