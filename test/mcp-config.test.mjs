// test/mcp-config.test.mjs
//
// Unit tests for lib/mcp-config.mjs's pure export (`sanitizeServerName`) and
// its FAILURE POLICY (`readDeclaredMcpServers`): "I don't know" must NEVER
// collapse into "zero". This is Defect #6 (config) and the root cause of
// Defect #7 (collisions) — see the module's own header comment for the full
// contract these tests hold it to.
//
// Hermetic: every test that exercises `readDeclaredMcpServers` overrides
// `process.env.PATH` for the duration of the test (restored via `t.after`,
// which runs even if the test throws) so it NEVER reaches the real `claude`
// binary this coding agent itself runs on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeclaredMcpServers, sanitizeServerName } from '../lib/mcp-config.mjs';
import { makeFakeClaude } from './helpers/fake-claude.mjs';

function withFakePath(t, dirOrEmpty) {
  const original = process.env.PATH;
  process.env.PATH = dirOrEmpty;
  t.after(() => {
    process.env.PATH = original;
  });
}

// ---------------------------------------------------------------------
// sanitizeServerName — pure function, and the root cause of Defect #7.
// ---------------------------------------------------------------------

test('sanitizeServerName: reemplaza todo caracter fuera de [A-Za-z0-9_] por "_"', () => {
  assert.equal(sanitizeServerName('claude.ai Gmail'), 'claude_ai_Gmail');
  assert.equal(sanitizeServerName('plugin:engram:engram'), 'plugin_engram_engram');
});

test('sanitizeServerName: NO es inyectiva — la colisión que causa el defecto #7', () => {
  // "foo bar" y "foo_bar" sanitizan al mismo nombre en el cable. Esta
  // igualdad NO es un bug de este test: es la razón por la que
  // declaredVsArrived() en bin/oxidegate-savings.mjs tiene que tratar toda
  // colisión como ambigüedad explícita, nunca fusionarla en silencio.
  assert.equal(sanitizeServerName('foo bar'), sanitizeServerName('foo_bar'));
});

// ---------------------------------------------------------------------
// readDeclaredMcpServers — FAILURE POLICY. Cada rama de abajo es un caso
// que el defecto #6 mezclaba con "0 servidores". Los cinco branches deben
// seguir siendo estructuralmente distinguibles: sólo UNO de ellos es
// `status: 'known'`, y sólo dentro de ese uno puede `servers` ser `[]`.
// ---------------------------------------------------------------------

test('readDeclaredMcpServers: "claude" no está en el PATH -> unknown/claude-not-found', async (t) => {
  withFakePath(t, '');
  const result = await readDeclaredMcpServers({ timeoutMs: 2000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'claude-not-found');
});

test('readDeclaredMcpServers: "claude mcp list" cuelga -> unknown/timeout (nunca known)', async (t) => {
  const fake = await makeFakeClaude({ hangMs: 5000 });
  t.after(() => fake.cleanup());
  withFakePath(t, fake.path);

  const result = await readDeclaredMcpServers({ timeoutMs: 150 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'timeout');
});

test('readDeclaredMcpServers: "claude mcp list" sale con código != 0 -> unknown/command-failed', async (t) => {
  const fake = await makeFakeClaude({ exitCode: 1, stdout: 'algo se rompió' });
  t.after(() => fake.cleanup());
  withFakePath(t, fake.path);

  const result = await readDeclaredMcpServers({ timeoutMs: 2000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'command-failed');
});

test('readDeclaredMcpServers: salida que no matchea el formato esperado -> unknown/unparseable', async (t) => {
  const fake = await makeFakeClaude({ stdout: 'esto no es una lista de servidores MCP\n' });
  t.after(() => fake.cleanup());
  withFakePath(t, fake.path);

  const result = await readDeclaredMcpServers({ timeoutMs: 2000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unparseable');
});

test('readDeclaredMcpServers: una sola línea con formato roto invalida TODA la lectura, no sólo esa línea', async (t) => {
  // Nombre de servidor con ": " adentro (vía .mcp.json escrito a mano) hace
  // que haya una SEGUNDA ": " en la línea, y la función no puede saber cuál
  // separador es el real. El comentario del módulo es explícito: esto debe
  // invalidar TODA la lectura como 'unparseable', no descartar sólo esa
  // línea (un undercount silencioso convertiría un "retenido" real en un
  // falso "nada retenido").
  const fake = await makeFakeClaude({
    stdout: 'good-server: node ./server.js - ✔ Connected\nevil: server - trap: node x - ⏸ Pending\n',
  });
  t.after(() => fake.cleanup());
  withFakePath(t, fake.path);

  const result = await readDeclaredMcpServers({ timeoutMs: 2000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unparseable');
});

test('readDeclaredMcpServers: 0 servidores configurados -> known CON servers:[] (un cero REAL, no confundible con "no sé")', async (t) => {
  const fake = await makeFakeClaude({ stdout: 'No MCP servers configured.\n' });
  t.after(() => fake.cleanup());
  withFakePath(t, fake.path);

  const result = await readDeclaredMcpServers({ timeoutMs: 2000 });
  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, []);
});

test('readDeclaredMcpServers: N servidores conectados y desconectados -> known con connected fiel al símbolo', async (t) => {
  const fake = await makeFakeClaude({
    stdout:
      'Checking MCP server health...\n' +
      'claude.ai Gmail: npx some-server - ✔ Connected\n' +
      'plugin:engram:engram: npx other-server - ⏸ Pending\n',
  });
  t.after(() => fake.cleanup());
  withFakePath(t, fake.path);

  const result = await readDeclaredMcpServers({ timeoutMs: 2000 });
  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, [
    { name: 'claude.ai Gmail', connected: true },
    { name: 'plugin:engram:engram', connected: false },
  ]);
});
