// test/mcp-protection.test.mjs
//
// Unit tests for lib/mcp-protection.mjs — which MCP servers the user has
// declared off-limits to the disable-by-default pass.
//
// The load-bearing case in this file is `unreadable config -> status
// 'unknown'`, NOT `-> []`. Every other reader in this repo treats absence as
// "we do not know". Here that rule has teeth: an empty list is an
// instruction to disconnect EVERYTHING, so a parser that quietly degrades a
// broken config into `[]` would disconnect the exact servers the user wrote
// that config to protect. The asymmetry is the point — see the pair
// `malformed_json_is_unknown_not_an_empty_allowlist` /
// `absent_config_is_a_known_empty_list`, which differ only in whether a file
// exists, and must NOT collapse to the same status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { readProtectedServers, readDisableByDefault as readDisableByDefaultFn, resolveProtectionConfigPath } from '../lib/mcp-protection.mjs';

/** Writes a throwaway config file and returns its path plus a cleanup. */
async function withConfig(content) {
  const dir = await mkdtemp(join(tmpdir(), 'oxidegate-lens-protection-'));
  const configDir = join(dir, '.config', 'oxidegate-lens');
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, 'config.json');
  if (content !== undefined) await writeFile(path, content);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('resolveProtectionConfigPath: lives under the user config dir, next to nothing else', () => {
  assert.equal(resolveProtectionConfigPath(), join(homedir(), '.config', 'oxidegate-lens', 'config.json'));
});

test('absent config is a KNOWN empty list — nothing protected, and we are sure of it', async () => {
  const { path, cleanup } = await withConfig(undefined);
  const result = readProtectedServers({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, []);
  assert.equal(result.source, 'default');
});

test('malformed JSON is UNKNOWN, not an empty allowlist — the pair that proves the guard reads the failure, not the file count', async () => {
  const { path, cleanup } = await withConfig('{ "protectedMcpServers": ["engram"');
  const result = readProtectedServers({ path, env: {} });
  await cleanup();

  // If this ever returns `{ status: 'known', servers: [] }` the caller will
  // read it as "protect nothing" and disconnect the servers this very file
  // was written to protect.
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'malformed-json');
  assert.equal(result.servers, undefined, 'an unknown result must not carry a list anyone could act on');
});

test('valid JSON of the wrong shape is UNKNOWN, never coerced into a list', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: 'engram' }));
  const result = readProtectedServers({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unrecognized-shape');
});

test('a config file with no protection key at all is a known empty list, not a shape error', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ somethingElse: true }));
  const result = readProtectedServers({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, []);
  assert.equal(result.source, 'file');
});

test('reads the protected list from the config file', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['engram', 'context7'] }));
  const result = readProtectedServers({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, ['engram', 'context7']);
  assert.equal(result.source, 'file');
});

test('non-string entries make the whole list UNKNOWN — a partial allowlist is worse than an admitted one', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['engram', 42, 'context7'] }));
  const result = readProtectedServers({ path, env: {} });
  await cleanup();

  // Silently dropping the 42 would leave a list that LOOKS complete and is
  // not. The caller cannot tell a filtered list from an intact one.
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unrecognized-shape');
});

test('OXIDEGATE_MCP_ALLOWLIST wins over the file — the existing env var keeps working', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['from-file'] }));
  const result = readProtectedServers({ path, env: { OXIDEGATE_MCP_ALLOWLIST: 'from-env, other' } });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, ['from-env', 'other'], 'entries are trimmed');
  assert.equal(result.source, 'env');
});

test('an env var DEFINED BUT EMPTY means "protect nothing", and does not fall through to the file', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['from-file'] }));
  const result = readProtectedServers({ path, env: { OXIDEGATE_MCP_ALLOWLIST: '' } });
  await cleanup();

  // Defined-but-empty is an explicit instruction, not an absent one. Falling
  // through to the file here would make it impossible to say "ignore my
  // config file this once" from the command line.
  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, []);
  assert.equal(result.source, 'env');
});

test('a broken config file is irrelevant when the env var is set — the env answer needs no file', async () => {
  const { path, cleanup } = await withConfig('{ broken');
  const result = readProtectedServers({ path, env: { OXIDEGATE_MCP_ALLOWLIST: 'engram' } });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.deepEqual(result.servers, ['engram']);
  assert.equal(result.source, 'env');
});

// =======================================================================
// planMcpDisable — the decision the protection list exists to inform.
//
// The dangerous branch is `protection.status !== 'known'`. Everywhere else
// an unknown degrades into a quieter report; here it would degrade into
// DISCONNECTING SERVERS. Refusing to act is the only safe response to not
// knowing what the user protected, and `targets` must be absent (not empty)
// so a caller that ignores `action` still cannot iterate its way into harm.
// =======================================================================

test('planMcpDisable: unknown protection REFUSES, and offers no targets to iterate', async () => {
  const { planMcpDisable } = await import('../lib/mcp-protection.mjs');

  const plan = planMcpDisable({
    servers: ['engram', 'context7'],
    protection: { status: 'unknown', reason: 'malformed-json', source: 'file' },
  });

  assert.equal(plan.action, 'refuse');
  assert.equal(plan.reason, 'protection-unknown');
  assert.equal(plan.targets, undefined, 'a refusal must not hand anyone a list to disconnect');
  assert.equal(plan.protectionReason, 'malformed-json', 'the caller must be able to tell the user WHY it refused');
});

test('planMcpDisable: known protection disables everything not on the list', async () => {
  const { planMcpDisable } = await import('../lib/mcp-protection.mjs');

  const plan = planMcpDisable({
    servers: ['engram', 'context7', 'otro'],
    protection: { status: 'known', servers: ['engram'], source: 'file' },
  });

  assert.equal(plan.action, 'disable');
  assert.deepEqual(plan.targets, ['context7', 'otro']);
  assert.deepEqual(plan.preserved, ['engram']);
});

test('planMcpDisable: a protected name that matches no live server is reported, never silently ignored', async () => {
  const { planMcpDisable } = await import('../lib/mcp-protection.mjs');

  const plan = planMcpDisable({
    servers: ['engram'],
    protection: { status: 'known', servers: ['engram', 'typo-server'], source: 'file' },
  });

  // A typo in the config is indistinguishable from a server that is simply
  // off right now — and the user believes they protected something. Saying
  // so is the difference between a config that works and one that looks
  // like it does.
  assert.deepEqual(plan.unmatchedProtections, ['typo-server']);
});

test('planMcpDisable: nothing to disable is its own outcome, not an empty disable', async () => {
  const { planMcpDisable } = await import('../lib/mcp-protection.mjs');

  const plan = planMcpDisable({
    servers: ['engram'],
    protection: { status: 'known', servers: ['engram'], source: 'file' },
  });

  assert.equal(plan.action, 'nothing-to-do');
  assert.deepEqual(plan.preserved, ['engram']);
});

test('planMcpDisable: no servers at all is nothing-to-do, never a refusal', async () => {
  const { planMcpDisable } = await import('../lib/mcp-protection.mjs');

  const plan = planMcpDisable({ servers: [], protection: { status: 'known', servers: [], source: 'default' } });

  assert.equal(plan.action, 'nothing-to-do');
});

// =======================================================================
// readDisableByDefault — the switch, moved next to the list it governs.
//
// It lived in OXIDEGATE_MCP_DISABLE_BY_DEFAULT alone, and that failed a real
// test: the author of this feature opened OpenCode without exporting it, with
// the instructions in front of him, so the whole thing silently never ran. A
// switch you must remember to export before launching a process is a switch
// that is off most of the time.
//
// It also made the configuration incoherent — the protected LIST lived in
// config.json while the SWITCH that uses it lived in an environment
// variable. Two mechanisms to learn for one feature.
// =======================================================================

test('readDisableByDefault: absent config means off, and we are sure of it', async () => {
  const { readDisableByDefault } = await import('../lib/mcp-protection.mjs');
  const { path, cleanup } = await withConfig(undefined);
  const result = readDisableByDefault({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.equal(result.enabled, false);
  assert.equal(result.source, 'default');
});

test('readDisableByDefault: the config file can turn it on — no env var needed', async () => {
  const { readDisableByDefault } = await import('../lib/mcp-protection.mjs');
  const { path, cleanup } = await withConfig(JSON.stringify({ disableByDefault: true, protectedMcpServers: ['engram'] }));
  const result = readDisableByDefault({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'known');
  assert.equal(result.enabled, true);
  assert.equal(result.source, 'file');
});

test('readDisableByDefault: the env var still wins, so nothing already configured breaks', async () => {
  const { readDisableByDefault } = await import('../lib/mcp-protection.mjs');
  const { path, cleanup } = await withConfig(JSON.stringify({ disableByDefault: false }));
  const result = readDisableByDefault({ path, env: { OXIDEGATE_MCP_DISABLE_BY_DEFAULT: '1' } });
  await cleanup();

  assert.equal(result.enabled, true);
  assert.equal(result.source, 'env');
});

test('readDisableByDefault: the env var can also turn it OFF against a file that turns it on', async () => {
  const { readDisableByDefault } = await import('../lib/mcp-protection.mjs');
  const { path, cleanup } = await withConfig(JSON.stringify({ disableByDefault: true }));
  const result = readDisableByDefault({ path, env: { OXIDEGATE_MCP_DISABLE_BY_DEFAULT: '0' } });
  await cleanup();

  // An override that can only ever turn things ON is not an override.
  assert.equal(result.enabled, false);
  assert.equal(result.source, 'env');
});

test('readDisableByDefault: a non-boolean value is UNKNOWN, never coerced', async () => {
  const { readDisableByDefault } = await import('../lib/mcp-protection.mjs');
  const { path, cleanup } = await withConfig(JSON.stringify({ disableByDefault: 'sí' }));
  const result = readDisableByDefault({ path, env: {} });
  await cleanup();

  // `Boolean('sí')` is true, which would silently start disconnecting
  // servers because someone wrote the value in Spanish.
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unrecognized-shape');
  assert.equal(result.enabled, undefined, 'an unknown switch must not hand anyone a value to act on');
});

test('readDisableByDefault: an unreadable config is UNKNOWN, and unknown must not mean on', async () => {
  const { readDisableByDefault } = await import('../lib/mcp-protection.mjs');
  const { path, cleanup } = await withConfig('{ "disableByDefault": tru');
  const result = readDisableByDefault({ path, env: {} });
  await cleanup();

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'malformed-json');
  assert.equal(result.enabled, undefined);
});

// =======================================================================
// La capa de proyecto en la precedencia.
//
// Decidido con el usuario: env var > proyecto (si está aprobado) > global >
// por defecto. Y el proyecto REEMPLAZA a lo global, no se fusiona — es una
// decisión de seguridad, y ahí la previsibilidad vale más que la comodidad:
// lees un fichero y sabes la respuesta, en vez de componer dos mentalmente.
//
// El resultado de `readProjectConfig` lo pasa el LLAMADOR ya leído, para que
// estas funciones sigan siendo puras y el fichero no se lea dos veces.
// =======================================================================

const projectApproved = (config) => ({ status: 'approved', path: '/repo/.oxidegate-lens.json', config });

test('proyecto aprobado REEMPLAZA la lista global, no la fusiona', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['global-uno', 'global-dos'] }));
  const result = readProtectedServers({
    path,
    env: {},
    projectConfig: projectApproved({ protectedMcpServers: ['solo-del-proyecto'] }),
  });
  await cleanup();

  assert.deepEqual(result.servers, ['solo-del-proyecto'], 'lo global no se arrastra');
  assert.equal(result.source, 'project');
});

test('un proyecto PENDIENTE no se aplica: manda lo global', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['global'] }));
  const result = readProtectedServers({
    path,
    env: {},
    projectConfig: { status: 'pending', path: '/repo/.oxidegate-lens.json', approvalHash: 'abc' },
  });
  await cleanup();

  assert.deepEqual(result.servers, ['global']);
  assert.equal(result.source, 'file', 'sin aprobar, el proyecto no existe a efectos de precedencia');
});

test('la env var sigue ganando incluso a un proyecto aprobado', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['global'] }));
  const result = readProtectedServers({
    path,
    env: { OXIDEGATE_MCP_ALLOWLIST: 'del-entorno' },
    projectConfig: projectApproved({ protectedMcpServers: ['del-proyecto'] }),
  });
  await cleanup();

  assert.deepEqual(result.servers, ['del-entorno'], 'la variable es la vía de escape y no se le quita');
  assert.equal(result.source, 'env');
});

test('un proyecto aprobado que no habla de protección cae a lo global', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ protectedMcpServers: ['global'] }));
  const result = readProtectedServers({
    path,
    env: {},
    projectConfig: projectApproved({ disableByDefault: true }),
  });
  await cleanup();

  // Reemplazar sólo aplica a lo que el proyecto DECLARA. Callar sobre una
  // clave no es declararla vacía — la misma regla que en el fichero global.
  assert.deepEqual(result.servers, ['global']);
  assert.equal(result.source, 'file');
});

test('el interruptor también respeta la capa de proyecto', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ disableByDefault: false }));
  const result = readDisableByDefaultFn({
    path,
    env: {},
    projectConfig: projectApproved({ disableByDefault: true }),
  });
  await cleanup();

  assert.equal(result.enabled, true);
  assert.equal(result.source, 'project');
});

test('un proyecto aprobado con un interruptor no booleano es UNKNOWN, no se coacciona', async () => {
  const { path, cleanup } = await withConfig(JSON.stringify({ disableByDefault: false }));
  const result = readDisableByDefaultFn({
    path,
    env: {},
    projectConfig: projectApproved({ disableByDefault: 'sí' }),
  });
  await cleanup();

  assert.equal(result.status, 'unknown');
  assert.equal(result.enabled, undefined);
});
