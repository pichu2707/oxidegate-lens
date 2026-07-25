// test/mcp-project-config.test.mjs
//
// Unit tests for lib/mcp-project-config.mjs — la capa de configuración por
// proyecto, y su modelo de confianza.
//
// EL PROBLEMA QUE RESUELVE, Y POR QUÉ NO ES PARANOIA
// ---------------------------------------------------
// Un `.oxidegate-lens.json` dentro de un repo clonado es CÓDIGO AJENO. Puede
// desconectar servidores MCP que querías conservar, o —peor, porque es
// silencioso— marcar como protegido uno que querías apagar, dejándotelo
// cargado sin que lo notes. Que clonar un repo cambie qué MCPs corres no
// puede pasar sin consentimiento.
//
// LA APROBACIÓN ES POR CONTENIDO, NO POR RUTA
// ---------------------------------------------
// Modelo de `direnv`, que lleva años resolviendo exactamente esto. Aprobar
// una ruta para siempre dejaría que el repo cambiara el fichero mañana y se
// aplicara solo. Aprobar un CONTENIDO significa que cualquier edición —tuya
// o de un `git pull`— vuelve a pedir permiso.
//
// Y un fichero pendiente NUNCA es silencioso: si no se puede aplicar, hay que
// poder decírselo al usuario. Un fichero que el usuario escribió y que no se
// aplica sin avisar es la otra mitad del mismo fallo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveProjectConfigPath,
  approvalFor,
  readProjectConfig,
} from '../lib/mcp-project-config.mjs';

async function withProject(content) {
  const dir = await mkdtemp(join(tmpdir(), 'oxidegate-project-'));
  if (content !== undefined) await writeFile(join(dir, '.oxidegate-lens.json'), content);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const CONFIG = JSON.stringify({ disableByDefault: true, protectedMcpServers: ['engram'] });

test('resolveProjectConfigPath: un solo fichero, visible, en la raíz del proyecto', () => {
  assert.equal(resolveProjectConfigPath('/repo'), join('/repo', '.oxidegate-lens.json'));
});

test('sin fichero de proyecto no hay nada que decidir', async () => {
  const { dir, cleanup } = await withProject(undefined);
  const result = readProjectConfig({ cwd: dir, approvals: {} });
  await cleanup();

  assert.equal(result.status, 'none');
});

test('un fichero SIN aprobar no se aplica, pero SÍ se reporta', async () => {
  const { dir, cleanup } = await withProject(CONFIG);
  const result = readProjectConfig({ cwd: dir, approvals: {} });
  await cleanup();

  // Las dos mitades del mismo fallo: aplicarlo sin permiso es inseguro,
  // ignorarlo en silencio deja al usuario creyendo que su fichero funciona.
  assert.equal(result.status, 'pending');
  assert.equal(result.config, undefined, 'un pendiente no puede traer configuración que alguien aplique');
  assert.ok(result.path.endsWith('.oxidegate-lens.json'));
  assert.ok(result.approvalHash, 'debe traer el hash que habría que aprobar');
});

test('aprobado por CONTENIDO: se aplica', async () => {
  const { dir, cleanup } = await withProject(CONFIG);
  const hash = approvalFor(CONFIG);
  const path = resolveProjectConfigPath(dir);

  const result = readProjectConfig({ cwd: dir, approvals: { [path]: hash } });
  await cleanup();

  assert.equal(result.status, 'approved');
  assert.deepEqual(result.config.protectedMcpServers, ['engram']);
  assert.equal(result.config.disableByDefault, true);
});

test('si el CONTENIDO cambia tras aprobarlo, vuelve a estar pendiente', async () => {
  const { dir, cleanup } = await withProject(JSON.stringify({ protectedMcpServers: ['otro'] }));
  const path = resolveProjectConfigPath(dir);
  // Aprobación del contenido ANTERIOR.
  const result = readProjectConfig({ cwd: dir, approvals: { [path]: approvalFor(CONFIG) } });
  await cleanup();

  // Es la razón de ser del modelo por contenido: aprobar una ruta para
  // siempre dejaría que un `git pull` cambiara el fichero y se aplicara solo.
  assert.equal(result.status, 'pending');
  assert.equal(result.config, undefined);
});

test('aprobar la ruta de OTRO proyecto no aprueba este', async () => {
  const { dir, cleanup } = await withProject(CONFIG);
  const result = readProjectConfig({ cwd: dir, approvals: { '/otro/sitio/.oxidegate-lens.json': approvalFor(CONFIG) } });
  await cleanup();

  assert.equal(result.status, 'pending', 'la aprobación es de una ruta Y un contenido, no de un contenido suelto');
});

test('un fichero de proyecto ilegible es UNREADABLE, y tampoco se aplica', async () => {
  const { dir, cleanup } = await withProject('{ roto');
  const path = resolveProjectConfigPath(dir);
  const result = readProjectConfig({ cwd: dir, approvals: { [path]: approvalFor('{ roto') } });
  await cleanup();

  // Aprobado o no, un JSON que no se puede interpretar no produce
  // configuración. Y se dice, en vez de degradar en silencio a lo global.
  assert.equal(result.status, 'unreadable');
  assert.equal(result.reason, 'malformed-json');
  assert.equal(result.config, undefined);
});

test('una forma válida pero inesperada tampoco se coacciona', async () => {
  const raw = JSON.stringify(['engram']);
  const { dir, cleanup } = await withProject(raw);
  const path = resolveProjectConfigPath(dir);
  const result = readProjectConfig({ cwd: dir, approvals: { [path]: approvalFor(raw) } });
  await cleanup();

  assert.equal(result.status, 'unreadable');
  assert.equal(result.reason, 'unrecognized-shape');
});

test('approvalFor es estable para el mismo contenido y distinto para otro', () => {
  assert.equal(approvalFor(CONFIG), approvalFor(CONFIG));
  assert.notEqual(approvalFor(CONFIG), approvalFor(`${CONFIG} `), 'un byte de diferencia es otro contenido');
});

test('sin cwd no se inventa un proyecto', () => {
  assert.equal(readProjectConfig({ cwd: undefined, approvals: {} }).status, 'none');
});

// =======================================================================
// Almacén de aprobaciones.
//
// La dirección segura del fallo importa: si el fichero de aprobaciones no se
// puede leer, la respuesta es «nada está aprobado», no «todo lo está». Un
// error de lectura deja los proyectos PENDIENTES, que es incómodo y seguro,
// en vez de aplicarlos, que sería cómodo y peligroso.
// =======================================================================

test('sin fichero de aprobaciones, nada está aprobado', async () => {
  const { readApprovals } = await import('../lib/mcp-project-config.mjs');
  assert.deepEqual(readApprovals({ path: '/no/existe/approvals.json' }), {});
});

test('un fichero de aprobaciones ILEGIBLE no aprueba nada', async () => {
  const { readApprovals } = await import('../lib/mcp-project-config.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'approvals-'));
  const path = join(dir, 'approvals.json');
  await writeFile(path, '{ roto');
  const result = readApprovals({ path });
  await rm(dir, { recursive: true, force: true });

  // Degradar a "todo aprobado" ante un JSON roto sería exactamente el fallo
  // que este modelo existe para impedir.
  assert.deepEqual(result, {});
});

test('lee el mapa ruta -> hash', async () => {
  const { readApprovals } = await import('../lib/mcp-project-config.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'approvals-'));
  const path = join(dir, 'approvals.json');
  await writeFile(path, JSON.stringify({ '/repo/.oxidegate-lens.json': 'deadbeef' }));
  const result = readApprovals({ path });
  await rm(dir, { recursive: true, force: true });

  assert.equal(result['/repo/.oxidegate-lens.json'], 'deadbeef');
});

test('entradas que no son string se descartan, sin tumbar el resto', async () => {
  const { readApprovals } = await import('../lib/mcp-project-config.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'approvals-'));
  const path = join(dir, 'approvals.json');
  await writeFile(path, JSON.stringify({ '/a': 'hash', '/b': 42, '/c': null }));
  const result = readApprovals({ path });
  await rm(dir, { recursive: true, force: true });

  // Aquí filtrar SÍ es correcto, al revés que en la lista de protegidos: una
  // entrada basura no puede aprobar nada, y descartarla es más restrictivo,
  // no menos. La asimetría es deliberada.
  assert.deepEqual(Object.keys(result), ['/a']);
});
