// test/proxy-version.test.mjs
//
// Unit tests for lib/proxy-version.mjs — leer el contrato de capacidades que
// publica OxideGate en GET /version.
//
// POR QUÉ EXISTE ESTE MÓDULO
// ---------------------------
// OxideGate publica `/version`, un endpoint de CAPACIDADES, y hasta ahora la
// lens nunca lo consultaba. Sin él, la lens tiene que "sondear por
// ausencia": no puede distinguir «este proxy no soporta esto» de «aquí no
// había dato». Ese fallo exacto ya ocurrió dos veces (`tool_names`,
// `/health`).
//
// LA REGLA QUE GOBIERNA TODO EL MÓDULO
// --------------------------------------
// Un 404 en /version NO es un fallo. Es la respuesta AFIRMATIVA «este proxy
// es anterior a la introducción del contrato» — información útil, no un
// hueco. Y en los dos helpers tri-estado, `null` («no pudimos preguntar»)
// JAMÁS se colapsa en `false` («el proxy nos dijo que no lo publica») — es
// exactamente el pecado que este módulo existe para no cometer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readProxyVersion, publishesEndpoint, publishesField } from '../lib/proxy-version.mjs';

const CONTRATO_REAL = {
  contract: 1,
  endpoints: ['/health', '/stats', '/sessions', '/requests', '/mcp', '/history'],
  fields: [
    'cache_by_section',
    'input_share_by_section',
    'prompt_bytes',
    'tool_names',
    'tool_calls',
    'tool_search',
    'tools_flattened',
    'skills',
    'instructions',
    'hooks',
    'effort_forced',
    'response_bytes',
    'codex_quota',
    'session',
    'prepare_us',
    'scan_us',
  ],
  oxidegate: '0.13.0',
};

/** Fabrica un fetchImpl falso que nunca toca la red de verdad. */
function fakeFetch(handler) {
  return async (url, opts) => handler(url, opts);
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

// ------------------------------------------------------------- readProxyVersion

test('readProxyVersion: 200 con forma válida -> known, con el contrato completo', async () => {
  const fetchImpl = fakeFetch(async (url) => {
    assert.equal(url, 'http://127.0.0.1:8899/version');
    return jsonResponse(200, CONTRATO_REAL);
  });

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl });

  assert.deepEqual(result, { status: 'known', ...CONTRATO_REAL });
});

test('readProxyVersion: 404 -> known con reason pre-contract, NUNCA unknown', () => {
  return (async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(404, { error: 'not found' }));

    const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl });

    // Este es EL caso crítico del módulo: un 404 aquí es información
    // afirmativa ("proxy anterior al contrato"), no un fallo de sondeo.
    assert.deepEqual(result, { status: 'known', reason: 'pre-contract' });
  })();
});

test('readProxyVersion: fetch que lanza (proxy inalcanzable) -> unknown/unreachable', async () => {
  const fetchImpl = fakeFetch(async () => {
    throw new TypeError('fetch failed');
  });

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:9', fetchImpl });

  assert.deepEqual(result, { status: 'unknown', reason: 'unreachable' });
});

test('readProxyVersion: timeout -> unknown/timeout, no se confunde con inalcanzable', async () => {
  const fetchImpl = fakeFetch(async () => {
    const err = new DOMException('The operation timed out.', 'TimeoutError');
    throw err;
  });

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl, timeoutMs: 10 });

  assert.deepEqual(result, { status: 'unknown', reason: 'timeout' });
});

test('readProxyVersion: JSON ilegible -> unknown/unparseable', async () => {
  const fetchImpl = fakeFetch(async () => ({
    status: 200,
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  }));

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl });

  assert.deepEqual(result, { status: 'unknown', reason: 'unparseable' });
});

test('readProxyVersion: otro código HTTP (500) -> unknown/http-500', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(500, { error: 'boom' }));

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl });

  assert.deepEqual(result, { status: 'unknown', reason: 'http-500' });
});

test('readProxyVersion: 200 pero sin endpoints (forma inesperada) -> unknown, sin inventar campos', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(200, { contract: 1, fields: [], oxidegate: '0.13.0' }));

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl });

  assert.equal(result.status, 'unknown');
  assert.ok(result.reason, 'debe llevar un reason propio');
  assert.equal(result.endpoints, undefined, 'no se inventa un array de endpoints ausente');
});

test('readProxyVersion: 200 pero endpoints no es array -> unknown', async () => {
  const fetchImpl = fakeFetch(async () =>
    jsonResponse(200, { contract: 1, endpoints: 'no-soy-un-array', fields: [], oxidegate: '0.13.0' }),
  );

  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:8899', fetchImpl });

  assert.equal(result.status, 'unknown');
});

test('readProxyVersion: usa fetch real como default cuando no se inyecta fetchImpl', async () => {
  // No llamamos a esto contra la red — solo comprobamos que la firma acepta
  // no pasar fetchImpl sin explotar por "fetchImpl is not a function" antes
  // siquiera de intentar la petición. Apuntamos a un puerto cerrado para que
  // el intento real falle rápido y caiga en la rama 'unreachable'.
  const result = await readProxyVersion({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 300 });
  assert.equal(result.status, 'unknown');
});

// -------------------------------------------------------- publishesEndpoint

test('publishesEndpoint: known con el endpoint presente -> true', () => {
  assert.equal(publishesEndpoint({ status: 'known', ...CONTRATO_REAL }, '/sessions'), true);
});

test('publishesEndpoint: known SIN el endpoint -> false, no null', () => {
  assert.equal(publishesEndpoint({ status: 'known', ...CONTRATO_REAL }, '/nope'), false);
});

test('publishesEndpoint: unknown -> null, nunca false', () => {
  assert.equal(publishesEndpoint({ status: 'unknown', reason: 'unreachable' }, '/sessions'), null);
});

test('publishesEndpoint: pre-contract -> null, un proxy sin /version no dijo nada sobre sus endpoints', () => {
  assert.equal(publishesEndpoint({ status: 'known', reason: 'pre-contract' }, '/sessions'), null);
});

// ----------------------------------------------------------- publishesField

test('publishesField: known con el campo presente -> true', () => {
  assert.equal(publishesField({ status: 'known', ...CONTRATO_REAL }, 'session'), true);
});

test('publishesField: known SIN el campo -> false, no null', () => {
  assert.equal(publishesField({ status: 'known', ...CONTRATO_REAL }, 'no-existe'), false);
});

test('publishesField: unknown -> null, nunca false', () => {
  assert.equal(publishesField({ status: 'unknown', reason: 'timeout' }, 'session'), null);
});

test('publishesField: pre-contract -> null, no se colapsa en false', () => {
  assert.equal(publishesField({ status: 'known', reason: 'pre-contract' }, 'session'), null);
});
