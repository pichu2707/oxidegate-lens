// test/session-report.test.mjs
//
// Unit tests for lib/session-report.mjs — la lógica de honestidad de la
// segunda lente (issue #18). Cada test de este fichero vigila UNA de las
// reglas de honestidad del brief, no sólo la forma del dato.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionReport } from '../lib/session-report.mjs';

// --------------------------------------------------------------- la forma

test('buildSessionReport: body null -> unexpected-shape, nunca lanza', () => {
  assert.deepEqual(buildSessionReport(null), { status: 'unexpected-shape' });
});

test('buildSessionReport: body sin `sessions` array -> unexpected-shape', () => {
  assert.deepEqual(buildSessionReport({ saturated: false }), { status: 'unexpected-shape' });
});

test('buildSessionReport: body sin `saturated` boolean -> unexpected-shape', () => {
  assert.deepEqual(buildSessionReport({ sessions: [] }), { status: 'unexpected-shape' });
});

test('buildSessionReport: `sessions` no es array -> unexpected-shape', () => {
  assert.deepEqual(buildSessionReport({ saturated: false, sessions: 'nope' }), {
    status: 'unexpected-shape',
  });
});

// -------------------------------------------- sessions: [] vacío de verdad

test('buildSessionReport: sessions: [] real es `known` con arrays vacíos, no un fallo de lectura', () => {
  const report = buildSessionReport({ saturated: false, sessions: [] });
  assert.equal(report.status, 'known');
  assert.deepEqual(report.sessions, []);
  assert.deepEqual(report.unattributed, []);
  assert.deepEqual(report.unclassified, []);
  assert.deepEqual(report.fixedToll, []);
});

// ------------------------------------------------------- clasificación (4)

test('buildSessionReport: is_session true y is_session false van a bloques SEPARADOS, nunca mezclados', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'ses_a', is_session: true, source: 'explicit', cost_usd: 1, requests: 3, input_tokens: 10, cache_read_tokens: 0, output_tokens: 5 },
      { key: 'opencode/1.18.25', is_session: false, source: 'unattributed', cost_usd: 0, requests: 73, input_tokens: 39944, cache_read_tokens: 0, output_tokens: 0 },
    ],
  });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.unattributed.length, 1);
  assert.equal(report.sessions[0].key, 'ses_a');
  assert.equal(report.unattributed[0].key, 'opencode/1.18.25');
  // ninguna fila is_session:false aparece en `sessions`, y viceversa.
  assert.ok(!report.sessions.some((r) => r.key === 'opencode/1.18.25'));
  assert.ok(!report.unattributed.some((r) => r.key === 'ses_a'));
});

test('buildSessionReport: is_session ausente o no-booleano va a `unclassified`, nunca se descarta en silencio', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [{ key: 'ses_raro', source: 'explicit', cost_usd: 1, requests: 1 }],
  });
  assert.equal(report.sessions.length, 0);
  assert.equal(report.unattributed.length, 0);
  assert.equal(report.unclassified.length, 1);
  assert.equal(report.unclassified[0].key, 'ses_raro');
});

test('buildSessionReport: una fila que no es objeto se descarta sin reventar', () => {
  const report = buildSessionReport({ saturated: false, sessions: ['no-soy-un-objeto', 42, null] });
  assert.equal(report.status, 'known');
  assert.deepEqual(report.sessions, []);
  assert.deepEqual(report.unattributed, []);
  assert.deepEqual(report.unclassified, []);
});

// -------------------------------------- Regla 1: los cuatro cuadrantes

test('buildSessionReport: is_session true + cost_usd 0 sigue siendo una SESIÓN con coste real 0, no un unknown', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'ses_sin_precio', is_session: true, source: 'explicit', cost_usd: 0, requests: 4, input_tokens: 100, cache_read_tokens: 0, output_tokens: 20 },
    ],
  });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.unattributed.length, 0);
  assert.equal(report.sessions[0].costUsd, 0);
  assert.notEqual(report.sessions[0].costUsd, null);
});

test('buildSessionReport: is_session false con cost_usd distinto de 0 no se fuerza a 0 ni se mueve a sessions', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'raro', is_session: false, source: 'unattributed', cost_usd: 0.5, requests: 2, input_tokens: 1, cache_read_tokens: 0, output_tokens: 0 },
    ],
  });
  assert.equal(report.sessions.length, 0);
  assert.equal(report.unattributed.length, 1);
  assert.equal(report.unattributed[0].costUsd, 0.5);
});

test('buildSessionReport: cost_usd ausente o no numérico se normaliza a null, nunca a 0', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [{ key: 'ses_sin_dato', is_session: true, source: 'explicit', requests: 1 }],
  });
  assert.equal(report.sessions[0].costUsd, null);
});

// --------------------------------------------------- orden por coste desc

test('buildSessionReport: sessions se ordena por coste DESCENDENTE', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'barato', is_session: true, cost_usd: 0.01, requests: 1 },
      { key: 'caro', is_session: true, cost_usd: 5, requests: 1 },
      { key: 'medio', is_session: true, cost_usd: 1, requests: 1 },
    ],
  });
  assert.deepEqual(report.sessions.map((r) => r.key), ['caro', 'medio', 'barato']);
});

test('buildSessionReport: sessions con coste desconocido se van al final, sin desordenar las conocidas entre sí', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'sin_coste_1', is_session: true, requests: 1 },
      { key: 'caro', is_session: true, cost_usd: 5, requests: 1 },
      { key: 'sin_coste_2', is_session: true, requests: 1 },
      { key: 'medio', is_session: true, cost_usd: 1, requests: 1 },
    ],
  });
  assert.deepEqual(report.sessions.map((r) => r.key), ['caro', 'medio', 'sin_coste_1', 'sin_coste_2']);
});

// -------------------------------------------------------------- key ausente

test('buildSessionReport: `key` ausente o no-string se normaliza a null, nunca a un string inventado', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [{ is_session: true, cost_usd: 1, requests: 1 }],
  });
  assert.equal(report.sessions[0].key, null);
});

// ---------------------------------------------------------------- totales

test('buildSessionReport: total de un grupo VACÍO es un cero real (nadie calló, no hay nada que sumar)', () => {
  const report = buildSessionReport({ saturated: false, sessions: [] });
  assert.deepEqual(report.totals.sessions, {
    count: 0,
    cost: 0,
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
});

test('buildSessionReport: si UNA fila calla un campo, el total de ese campo es null (desconocido), no una suma parcial', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'a', is_session: true, cost_usd: 1, requests: 3, input_tokens: 10 },
      { key: 'b', is_session: true, cost_usd: 2, requests: 5 }, // input_tokens ausente
    ],
  });
  assert.equal(report.totals.sessions.cost, 3);
  assert.equal(report.totals.sessions.requests, 8);
  assert.equal(report.totals.sessions.inputTokens, null);
});

test('buildSessionReport: los totales de sessions y de unattributed son independientes entre sí', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'ses', is_session: true, cost_usd: 1, requests: 3, input_tokens: 10, cache_read_tokens: 0, output_tokens: 0 },
      { key: 'bucket', is_session: false, cost_usd: 0, requests: 73, input_tokens: 39944, cache_read_tokens: 0, output_tokens: 0 },
    ],
  });
  assert.equal(report.totals.sessions.inputTokens, 10);
  assert.equal(report.totals.unattributed.inputTokens, 39944);
});

// -------------------------------------------------------- el peaje fijo (c)

test('buildSessionReport: un miembro null de fixed_toll es "unmeasured", JAMÁS 0 bytes', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      {
        key: 'ses',
        is_session: true,
        cost_usd: 1,
        requests: 26,
        fixed_toll: { hooks: null, instructions: null, skills: { bytes: 6839, seen_in: 25 } },
      },
    ],
  });
  const toll = report.fixedToll[0];
  assert.deepEqual(toll.members.hooks, { status: 'unmeasured' });
  assert.deepEqual(toll.members.instructions, { status: 'unmeasured' });
});

test('buildSessionReport: fixed_toll ausente por completo en la fila también es "unmeasured" en los tres miembros', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [{ key: 'ses', is_session: true, cost_usd: 1, requests: 3 }],
  });
  const toll = report.fixedToll[0];
  assert.deepEqual(toll.members.hooks, { status: 'unmeasured' });
  assert.deepEqual(toll.members.instructions, { status: 'unmeasured' });
  assert.deepEqual(toll.members.skills, { status: 'unmeasured' });
});

test('buildSessionReport: un miembro malformado (sin bytes o sin seen_in) se trata como unmeasured, nunca como parcialmente 0', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      {
        key: 'ses',
        is_session: true,
        cost_usd: 1,
        requests: 3,
        fixed_toll: { hooks: { bytes: 'no-es-un-numero' }, instructions: { seen_in: 5 }, skills: null },
      },
    ],
  });
  const toll = report.fixedToll[0];
  assert.equal(toll.members.hooks.status, 'unmeasured');
  assert.equal(toll.members.instructions.status, 'unmeasured');
});

test('buildSessionReport: miembro conocido + requests conocido -> calcula el producto bytes × seen_in (la tesis del N²)', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      {
        key: 'ses_f87dc264',
        is_session: true,
        cost_usd: 0.883174,
        requests: 26,
        fixed_toll: { hooks: null, instructions: null, skills: { bytes: 6839, seen_in: 25 } },
      },
    ],
  });
  const skills = report.fixedToll[0].members.skills;
  assert.equal(skills.status, 'known');
  assert.equal(skills.bytes, 6839);
  assert.equal(skills.seenIn, 25);
  assert.equal(skills.product, 6839 * 25);
});

test('buildSessionReport: miembro conocido pero requests DESCONOCIDO -> no se calcula el producto (nunca se fabrica)', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      {
        key: 'ses_sin_requests',
        is_session: true,
        cost_usd: 1,
        // requests ausente a propósito
        fixed_toll: { hooks: null, instructions: null, skills: { bytes: 6839, seen_in: 25 } },
      },
    ],
  });
  const skills = report.fixedToll[0].members.skills;
  assert.equal(skills.status, 'known');
  assert.equal(skills.bytes, 6839);
  assert.equal(skills.seenIn, 25);
  assert.equal(skills.product, null);
});

test('buildSessionReport: fixedToll cubre TANTO sessions como unattributed, en el mismo bloque de datos', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [
      { key: 'ses', is_session: true, cost_usd: 1, requests: 3, fixed_toll: { hooks: null, instructions: null, skills: null } },
      { key: 'bucket', is_session: false, cost_usd: 0, requests: 73, fixed_toll: { hooks: null, instructions: null, skills: null } },
    ],
  });
  assert.equal(report.fixedToll.length, 2);
  assert.equal(report.fixedToll[0].isSession, true);
  assert.equal(report.fixedToll[1].isSession, false);
});

// -------------------------------------------------------------- saturated

test('buildSessionReport: `saturated` se propaga verbatim, nunca se infiere', () => {
  assert.equal(buildSessionReport({ saturated: true, sessions: [] }).saturated, true);
  assert.equal(buildSessionReport({ saturated: false, sessions: [] }).saturated, false);
});

// --------------------------------------------------------------- source

test('buildSessionReport: `source` se pasa verbatim, y null cuando no es string', () => {
  const report = buildSessionReport({
    saturated: false,
    sessions: [{ key: 'a', is_session: true, source: 'explicit', cost_usd: 1, requests: 1 }],
  });
  assert.equal(report.sessions[0].source, 'explicit');

  const report2 = buildSessionReport({
    saturated: false,
    sessions: [{ key: 'b', is_session: true, cost_usd: 1, requests: 1 }],
  });
  assert.equal(report2.sessions[0].source, null);
});
