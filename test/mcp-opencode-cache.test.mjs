// test/mcp-opencode-cache.test.mjs
//
// Unit tests for lib/mcp-opencode-cache.mjs — la copia que OpenCode se guarda
// del plugin, y por qué puede dejar de ser la que crees.
//
// EL FALLO QUE ORIGINA ESTE MÓDULO
// ---------------------------------
// Se publicó 0.6.1 con el arreglo que hacía falta, y `opencode plugin
// oxidegate-lens` seguía fallando exactamente igual que con 0.6.0. El motivo:
//
//   ~/.cache/opencode/packages/oxidegate-lens@latest/package.json
//     -> { "dependencies": { "oxidegate-lens": "0.6.0" } }
//
// El directorio se llama `@latest` pero **tiene la versión clavada y no
// vuelve a resolver**. OpenCode estaba leyendo una copia vieja mientras npm
// ya servía la nueva, y el mensaje de error describía con toda precisión un
// paquete que ya no era el publicado.
//
// LA REGLA
// --------
// Una discrepancia se NOMBRA, no se arregla sola. Este módulo compara y
// cuenta; borrar es una acción destructiva y necesita que la pidan. Y una
// caché ausente NO es una caché vieja: son estados distintos y confundirlos
// mandaría a media base de usuarios a borrar un directorio que no existe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveOpenCodeCachePath,
  readCachedPluginVersion,
  diagnoseCache,
} from '../lib/mcp-opencode-cache.mjs';

// Monta la estructura REAL que crea OpenCode, no una inventada.
function cacheConVersion(version) {
  const home = mkdtempSync(join(tmpdir(), 'oc-cache-'));
  const dir = join(home, '.cache', 'opencode', 'packages', 'oxidegate-lens@latest');
  mkdirSync(dir, { recursive: true });
  if (version !== null) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'oxidegate-lens': version } }));
  }
  return { home, dir };
}

// ------------------------------------------------------------- resolveOpenCodeCachePath

test('la ruta es la que usa OpenCode de verdad, con el sufijo @latest', () => {
  const ruta = resolveOpenCodeCachePath({ home: '/casa' });

  assert.equal(ruta, '/casa/.cache/opencode/packages/oxidegate-lens@latest');
});

// ------------------------------------------------------------- readCachedPluginVersion

test('lee la versión clavada dentro del directorio que se llama @latest', () => {
  const { dir } = cacheConVersion('0.6.0');

  assert.deepEqual(readCachedPluginVersion({ path: dir }), { status: 'known', version: '0.6.0' });
});

test('sin caché el estado es AUSENTE, que no es lo mismo que vieja', () => {
  // Confundir "no hay copia" con "hay una copia vieja" mandaría a borrar un
  // directorio inexistente a todo el que instala por Homebrew y no por npm.
  assert.deepEqual(readCachedPluginVersion({ path: '/no/existe/en/ningun/sitio' }), { status: 'absent' });
});

test('un package.json corrupto es ILEGIBLE, nunca una versión inventada', () => {
  const { dir } = cacheConVersion(null);
  writeFileSync(join(dir, 'package.json'), '{ esto no es json');

  assert.deepEqual(readCachedPluginVersion({ path: dir }), { status: 'unreadable' });
});

test('un package.json sin la dependencia dentro tampoco inventa nada', () => {
  const { dir } = cacheConVersion(null);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { otra: '1.0.0' } }));

  assert.deepEqual(readCachedPluginVersion({ path: dir }), { status: 'unreadable' });
});

// -------------------------------------------------------------------- diagnoseCache

test('misma versión en caché y en ejecución -> nada que hacer', () => {
  const d = diagnoseCache({ cached: { status: 'known', version: '0.6.1' }, running: '0.6.1' });

  assert.equal(d.status, 'match');
});

test('EL CASO QUE ORIGINA EL MÓDULO: la caché tiene otra versión -> se NOMBRA', () => {
  const d = diagnoseCache({ cached: { status: 'known', version: '0.6.0' }, running: '0.6.1' });

  assert.equal(d.status, 'mismatch');
  assert.equal(d.cached, '0.6.0');
  assert.equal(d.running, '0.6.1');
});

test('sin caché no hay discrepancia que denunciar', () => {
  const d = diagnoseCache({ cached: { status: 'absent' }, running: '0.6.1' });

  assert.equal(d.status, 'absent');
});

test('una caché ilegible es DESCONOCIDA, jamás un "todo en orden"', () => {
  // La regla del repo, aplicada aquí: una comprobación que no se pudo hacer
  // no se declara correcta. Decir "todo bien" sobre algo que no se pudo leer
  // cierra la investigación que habría encontrado el problema.
  const d = diagnoseCache({ cached: { status: 'unreadable' }, running: '0.6.1' });

  assert.equal(d.status, 'unknown');
});

test('sin saber qué versión corre, no se juzga la caché', () => {
  for (const running of [null, undefined, '']) {
    const d = diagnoseCache({ cached: { status: 'known', version: '0.6.0' }, running });
    assert.equal(d.status, 'unknown', `running=${JSON.stringify(running)} no permite comparar`);
  }
});

test('el diagnóstico NO borra nada: solo cuenta lo que ve', () => {
  const { dir } = cacheConVersion('0.6.0');

  diagnoseCache({ cached: readCachedPluginVersion({ path: dir }), running: '0.6.1' });

  // Sigue ahí. Borrar es destructivo y se pide aparte, nunca como efecto
  // secundario de mirar.
  assert.deepEqual(readCachedPluginVersion({ path: dir }), { status: 'known', version: '0.6.0' });
});
