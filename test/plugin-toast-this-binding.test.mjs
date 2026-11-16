// test/plugin-toast-this-binding.test.mjs
//
// REGRESSION: in OpenCode's SDK 1.19.4 `client.tui` is a class instance and
// `showToast` reads `this._client`. The plugin used to detach the method
// (`const showToast = client?.tui?.showToast; showToast(...)`), so every call
// threw `TypeError ... 'this._client'` and the empty catch swallowed it: no
// toast was ever shown. Fake clients made of plain objects never noticed,
// because their methods do not touch `this`.
//
// These tests load the real plugin (Node strips the TypeScript types) and
// give it a `tui` whose `showToast` DEPENDS on `this`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic setup: the plugin reads $HOME-relative config/approvals/snapshot at
// call time and probes OXIDEGATE_PORT at load. Point everything at a scratch
// dir and an unused port, and force disable-by-default OFF, so the only toast
// source in these tests is the code path under test.
const scratch = mkdtempSync(join(tmpdir(), 'oxidegate-lens-toast-'));
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'OXIDEGATE_PORT',
  'OXIDEGATE_LENS_URL',
  'OXIDEGATE_LENS_DEBUG',
  'OXIDEGATE_LENS_SNAPSHOT',
  'OXIDEGATE_MCP_DISABLE_BY_DEFAULT',
  'OXIDEGATE_MCP_ALLOWLIST',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const unusedPort = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

process.env.HOME = scratch;
for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) process.env[k] = scratch;
process.env.OXIDEGATE_PORT = String(unusedPort);
delete process.env.OXIDEGATE_LENS_URL;
delete process.env.OXIDEGATE_LENS_DEBUG;
delete process.env.OXIDEGATE_LENS_SNAPSHOT;
delete process.env.OXIDEGATE_MCP_ALLOWLIST;
process.env.OXIDEGATE_MCP_DISABLE_BY_DEFAULT = '0';

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const { OxidegateLens } = await import('../opencode/oxidegate-lens.ts');

class FakeTui {
  constructor(failWith) {
    this._client = { delivered: [] };
    this.failWith = failWith;
  }
  // Throws exactly like the real SDK when called detached.
  async showToast(options) {
    if (this.failWith) throw this.failWith;
    this._client.delivered.push(options);
    return true;
  }
}

function makeClient(statusRef, failWith) {
  const tui = new FakeTui(failWith);
  return {
    tui,
    delivered: tui._client.delivered,
    mcp: {
      status: async () => ({ data: statusRef.current }),
      disconnect: async () => ({ data: true }),
    },
  };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('showNotice: a transition notice reaches a tui whose showToast needs `this`', async () => {
  const statusRef = { current: { alpha: { status: 'disabled' } } };
  const client = makeClient(statusRef);
  const hooks = await OxidegateLens({ client, directory: '/tmp/x' });
  await tick(); // let the startup pass settle

  await hooks.event({ event: { type: 'session.idle' } });
  statusRef.current = { alpha: { status: 'connected' } };
  await hooks.event({ event: { type: 'session.idle' } });

  assert.ok(
    client.delivered.some((t) => /se ha conectado: .*alpha/.test(t.body.message)),
    `expected the transition toast "se ha conectado: alpha", got ${JSON.stringify(client.delivered)}`,
  );
});

test('showMcpStatusToast: the valve tool delivers its toast through a `this`-bound tui', async () => {
  const statusRef = { current: { beta: { status: 'connected' } } };
  const client = makeClient(statusRef);
  const hooks = await OxidegateLens({ client, directory: '/tmp/x' });
  await tick();
  client.delivered.length = 0;

  const valve = hooks.tool?.oxidegate_lens_mcp_valve;
  assert.ok(valve, 'valve tool must be registered (@opencode-ai/plugin installed)');
  await valve.execute({}, { directory: '/tmp/x' });

  assert.ok(
    client.delivered.some((t) => t.body.title === 'OxideGate MCP actual' && /beta=connected/.test(t.body.message)),
    `expected the valve status toast, got ${JSON.stringify(client.delivered)}`,
  );
});

test('a client without tui.showToast stays best-effort and does not throw', async () => {
  const statusRef = { current: { alpha: { status: 'disabled' } } };
  const client = { mcp: makeClient(statusRef).mcp };
  const hooks = await OxidegateLens({ client, directory: '/tmp/x' });
  await tick();
  await hooks.event({ event: { type: 'session.idle' } });
  statusRef.current = { alpha: { status: 'connected' } };
  await hooks.event({ event: { type: 'session.idle' } });
});

test('a rejected showToast is logged under OXIDEGATE_LENS_DEBUG, not swallowed silently', async () => {
  process.env.OXIDEGATE_LENS_DEBUG = '1';
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const statusRef = { current: { alpha: { status: 'disabled' } } };
    const client = makeClient(statusRef, new Error('boom'));
    const hooks = await OxidegateLens({ client, directory: '/tmp/x' });
    await tick();
    await hooks.event({ event: { type: 'session.idle' } });
    statusRef.current = { alpha: { status: 'connected' } };
    await hooks.event({ event: { type: 'session.idle' } });
  } finally {
    console.log = realLog;
    delete process.env.OXIDEGATE_LENS_DEBUG;
  }
  assert.ok(
    lines.some((l) => /notice toast failed: boom/.test(l)),
    `expected a "notice toast failed" debug line, got ${JSON.stringify(lines)}`,
  );
});
