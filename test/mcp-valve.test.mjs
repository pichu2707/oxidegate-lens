// test/mcp-valve.test.mjs
//
// Unit tests for lib/mcp-valve.mjs's join, collision guard, joinHealth, and
// recommendation conjunction. See the module's own header comment for the
// full contract these tests hold it to — in particular design.md Decision 6
// (the mismatch/0-uses identity and why the `unknown` row exists) and
// Decision 7 (the recommendation gate is a conjunction of named refusals).
//
// Fixtures reuse the EXACT return shapes of `readMcpSavingsSnapshot`
// (lib/mcp-snapshot.mjs) and `observeMcpUsage` (lib/mcp-usage.mjs) — these
// are `buildValveRows`'s only two inputs, and both are pure data, so no I/O
// or fake clock is needed here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildValveRows } from '../lib/mcp-valve.mjs';

const MINUTE_MS = 60 * 1000;

/** One `mcpMeasurement` entry, in the shape readMcpSavingsSnapshot produces. */
function snapshotServer({ name, enabled, tokens, price }) {
  return { name, enabled, tokens, price };
}

const knownPrice = (bytes) => ({ status: 'known', bytes });
const unknownPrice = (reason = 'cannot-measure') => ({ status: 'unknown', reason });

/** A `{ status: 'known', ... }` SnapshotResult, per lib/mcp-snapshot.mjs. */
function knownSnapshot(servers) {
  return { status: 'known', freshness: 'fresh', timestamp: Date.now(), servers };
}

/** A `{ status: 'observed', ... }` UsageResult, per lib/mcp-usage.mjs. */
function observedUsage(usesByLabel, overrides = {}) {
  return {
    status: 'observed',
    windowMs: 45 * MINUTE_MS,
    usesByLabel,
    hasOthersBucket: false,
    ...overrides,
  };
}

/** A `{ status: 'insufficient-observation', ... }` UsageResult. */
function insufficientUsage(overrides = {}) {
  return { status: 'insufficient-observation', windowMs: 10 * MINUTE_MS, count: 2, ...overrides };
}

test('buildValveRows: exact match — snapshot name equals the wire label verbatim', () => {
  const snapshot = knownSnapshot([snapshotServer({ name: 'engram', enabled: true, tokens: 100, price: knownPrice(500) })]);
  const usage = observedUsage({ engram: 3 });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'engram');

  assert.ok(row, 'expected an "engram" row');
  assert.equal(row.join, 'exact');
  assert.equal(row.uses, 3);
  assert.equal(row.price.bytes, 500);
});

test('buildValveRows: sanitized match — raw snapshot name sanitizes to the wire label', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'claude.ai Gmail', enabled: true, tokens: null, price: knownPrice(200) }),
  ]);
  const usage = observedUsage({ claude_ai_Gmail: 4 });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.join === 'sanitized');

  assert.ok(row, 'expected a sanitized-match row');
  assert.equal(row.label, 'claude_ai_Gmail');
  assert.equal(row.uses, 4);
});

test('buildValveRows: two snapshot names sanitizing to the same wire label -> both rows ambiguous, never guessed', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'foo bar', enabled: true, tokens: null, price: knownPrice(100) }),
    snapshotServer({ name: 'foo_bar', enabled: true, tokens: null, price: knownPrice(200) }),
  ]);
  const usage = observedUsage({ foo_bar: 5 });

  const { rows, joinHealth } = buildValveRows({ snapshot, usage });
  const ambiguous = rows.filter((r) => r.join === 'ambiguous');

  assert.equal(ambiguous.length, 2, 'both colliding entries must render, neither picked arbitrarily');

  // The collision is the ONLY correspondence in this fixture, which is what
  // makes this assertion load-bearing: the shared sanitized key IS on the
  // wire, so the two instruments do agree about something — imperfectly, but
  // really. Without that being counted, a single unrelated collision would
  // read as "the instruments agree about nothing" and suppress every
  // recommendation fleet-wide. A fixture with a second, healthy match cannot
  // test this — that match alone would keep joinHealth 'ok' either way.
  assert.equal(joinHealth, 'ok', 'a collision matched on the wire is real correspondence, not silence');
  for (const row of ambiguous) {
    assert.equal(row.recommendation.status, 'no-recommendation');
    assert.equal(row.recommendation.reason, 'name-collision');
    assert.equal(row.uses, undefined, 'an ambiguous row cannot claim wire usage');
  }

  // The wire spend under the colliding label is real and observed — since
  // neither ambiguous entry can claim it, it must still surface, as its own
  // `unknown` row (Decision 6: observed spend is never dropped).
  const unknownRow = rows.find((r) => r.join === 'unknown' && r.label === 'foo_bar');
  assert.ok(unknownRow, 'wire spend under a colliding label must still render as an unknown row');
  assert.equal(unknownRow.uses, 5);
});

test('buildValveRows: snapshot-only — priced server with no wire match renders, not dropped', () => {
  const snapshot = knownSnapshot([snapshotServer({ name: 'off-server', enabled: true, tokens: null, price: knownPrice(999) })]);
  const usage = observedUsage({ 'other-server': 5 });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'off-server');

  assert.ok(row);
  assert.equal(row.join, 'snapshot-only');
  assert.equal(row.uses, 0, 'a real, confirmed zero — the window was checked and the label never appeared');
  assert.equal(row.price.bytes, 999);
});

test('buildValveRows: wire-only spend with no snapshot match -> unknown row, never dropped', () => {
  const snapshot = knownSnapshot([]);
  const usage = observedUsage({ 'mystery-server': 12 });

  const { rows } = buildValveRows({ snapshot, usage });

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.join, 'unknown');
  assert.equal(row.label, 'mystery-server');
  assert.equal(row.uses, 12);
  assert.equal(row.price, undefined, 'no snapshot entry exists for this label, so there is no price to show');
  assert.equal(row.recommendation.status, 'no-recommendation');
  assert.equal(row.recommendation.reason, 'unattributed-spend');
});

test('buildValveRows: no observed spend and no known price -> silence, the row is never manufactured', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'broken-server', enabled: true, tokens: null, price: unknownPrice('cannot-measure') }),
  ]);
  const usage = observedUsage({ 'other-server': 5 });

  const { rows } = buildValveRows({ snapshot, usage });

  assert.equal(
    rows.find((r) => r.label === 'broken-server'),
    undefined,
    'nothing observed and nothing priced is not a finding',
  );
});

test('buildValveRows: joinHealth "no-correspondence" suppresses EVERY recommendation fleet-wide', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'known-server-a', enabled: true, tokens: null, price: knownPrice(100) }),
    snapshotServer({ name: 'known-server-b', enabled: true, tokens: null, price: knownPrice(200) }),
  ]);
  // Wire traffic exists, but under a label matching NEITHER snapshot server —
  // the exact naming-bug signature joinHealth exists to detect.
  const usage = observedUsage({ 'totally-different-label': 8 });

  const { rows, joinHealth } = buildValveRows({ snapshot, usage });

  assert.equal(joinHealth, 'no-correspondence');
  const priced = rows.filter((r) => r.join === 'snapshot-only');
  assert.equal(priced.length, 2);
  for (const row of priced) {
    assert.equal(row.recommendation.status, 'no-recommendation');
    assert.equal(row.recommendation.reason, 'instruments-disagree');
  }
});

test('buildValveRows: healthy join (at least one match) does NOT suppress recommendations fleet-wide', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'used-server', enabled: true, tokens: null, price: knownPrice(50) }),
    snapshotServer({ name: 'unused-server', enabled: true, tokens: null, price: knownPrice(700) }),
  ]);
  const usage = observedUsage({ 'used-server': 6 });

  const { joinHealth } = buildValveRows({ snapshot, usage });

  assert.equal(joinHealth, 'ok');
});

test('buildValveRows: already-off — disabled, priced server renders the counterfactual, never "candidate to disable"', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'active-server', enabled: true, tokens: 50, price: knownPrice(300) }),
    snapshotServer({ name: 'disabled-server', enabled: false, tokens: 3788, price: knownPrice(17200) }),
  ]);
  const usage = observedUsage({ 'active-server': 10 });

  const { rows, joinHealth } = buildValveRows({ snapshot, usage });

  assert.equal(joinHealth, 'ok');
  const row = rows.find((r) => r.label === 'disabled-server');
  assert.ok(row);
  assert.equal(row.join, 'snapshot-only');
  assert.equal(row.recommendation.status, 'already-off');
  assert.notEqual(row.recommendation.status, 'candidate-to-disable');
});

test('buildValveRows: priced server, zero uses, healthy join -> candidate-to-disable', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'used-server', enabled: true, tokens: null, price: knownPrice(50) }),
    snapshotServer({ name: 'unused-server', enabled: true, tokens: null, price: knownPrice(700) }),
  ]);
  const usage = observedUsage({ 'used-server': 6 });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'unused-server');

  assert.equal(row.join, 'snapshot-only');
  assert.equal(row.uses, 0);
  assert.equal(row.recommendation.status, 'candidate-to-disable');
});

test('buildValveRows: insufficient observation -> no-recommendation, reason "insufficient-observation"', () => {
  const snapshot = knownSnapshot([snapshotServer({ name: 'engram', enabled: true, tokens: null, price: knownPrice(100) })]);
  const usage = insufficientUsage();

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'engram');

  assert.ok(row);
  assert.equal(row.join, 'snapshot-only');
  assert.equal(row.uses, undefined, 'sample too thin to judge — never a confirmed zero');
  assert.equal(row.recommendation.status, 'no-recommendation');
  assert.equal(row.recommendation.reason, 'insufficient-observation');
});

test('buildValveRows: (others) bucket present in the window -> no-recommendation, reason "not-individually-confirmed"', () => {
  const snapshot = knownSnapshot([snapshotServer({ name: 'engram', enabled: true, tokens: null, price: knownPrice(100) })]);
  const usage = observedUsage({ engram: 1 }, { hasOthersBucket: true });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'engram');

  assert.equal(row.recommendation.status, 'no-recommendation');
  assert.equal(row.recommendation.reason, 'not-individually-confirmed');
});

test('buildValveRows: matched row with unmeasurable price -> no-recommendation, reason "price-unknown"', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'engram', enabled: true, tokens: null, price: unknownPrice('cannot-measure') }),
  ]);
  const usage = observedUsage({ engram: 4 });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'engram');

  assert.equal(row.join, 'exact');
  assert.equal(row.uses, 4, 'real observed spend must still render even with an unknown price');
  assert.equal(row.recommendation.status, 'no-recommendation');
  assert.equal(row.recommendation.reason, 'price-unknown');
});

test('buildValveRows: priced server actively in use -> no-recommendation, reason "in-use" (nothing wrong to report)', () => {
  const snapshot = knownSnapshot([snapshotServer({ name: 'engram', enabled: true, tokens: 500, price: knownPrice(300) })]);
  const usage = observedUsage({ engram: 9 });

  const { rows } = buildValveRows({ snapshot, usage });
  const row = rows.find((r) => r.label === 'engram');

  assert.equal(row.recommendation.status, 'no-recommendation');
  assert.equal(row.recommendation.reason, 'in-use');
});

test('buildValveRows: nothing observed, nothing priced -> zero rows, joinHealth "ok", never throws', () => {
  const snapshot = { status: 'unknown', reason: 'missing-file' };
  const usage = insufficientUsage({ windowMs: 0, count: 0 });

  assert.doesNotThrow(() => buildValveRows({ snapshot, usage }));
  const { rows, joinHealth, windowMs } = buildValveRows({ snapshot, usage });

  assert.equal(rows.length, 0);
  assert.equal(joinHealth, 'ok', 'no measured servers exist, so there is nothing to disagree about');
  assert.equal(windowMs, 0);
});

test('buildValveRows: windowMs is exposed at the top level, verbatim from usage.windowMs', () => {
  const snapshot = knownSnapshot([snapshotServer({ name: 'engram', enabled: true, tokens: null, price: knownPrice(100) })]);
  const usage = observedUsage({ engram: 6 }, { windowMs: 3 * 60 * MINUTE_MS });

  const { windowMs } = buildValveRows({ snapshot, usage });

  assert.equal(windowMs, 3 * 60 * MINUTE_MS);
});

test('buildValveRows: snapshotFreshness/snapshotTimestamp pass through verbatim for a fresh snapshot', () => {
  const ts = Date.now();
  const snapshot = { status: 'known', freshness: 'fresh', timestamp: ts, servers: [] };
  const usage = observedUsage({});

  const { snapshotFreshness, snapshotTimestamp } = buildValveRows({ snapshot, usage });

  assert.equal(snapshotFreshness, 'fresh');
  assert.equal(snapshotTimestamp, ts);
});

test('buildValveRows: snapshotFreshness/snapshotTimestamp pass through verbatim for a stale snapshot', () => {
  const ts = Date.now() - 30 * 60 * 60 * 1000;
  const snapshot = { status: 'known', freshness: 'stale', timestamp: ts, servers: [] };
  const usage = observedUsage({});

  const { snapshotFreshness, snapshotTimestamp } = buildValveRows({ snapshot, usage });

  assert.equal(snapshotFreshness, 'stale');
  assert.equal(snapshotTimestamp, ts);
});

test('buildValveRows: snapshotFreshness/snapshotTimestamp are undefined when there is no known snapshot (absence stays absence, never a guessed "stale")', () => {
  const snapshot = { status: 'unknown', reason: 'missing-file' };
  const usage = observedUsage({});

  const { snapshotFreshness, snapshotTimestamp } = buildValveRows({ snapshot, usage });

  assert.equal(snapshotFreshness, undefined);
  assert.equal(snapshotTimestamp, undefined);
});

test('buildValveRows: a name-collision matched by the wire does not break joinHealth when a second, unrelated server also genuinely matches', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'foo bar', enabled: true, tokens: null, price: knownPrice(100) }),
    snapshotServer({ name: 'foo_bar', enabled: true, tokens: null, price: knownPrice(200) }),
    snapshotServer({ name: 'used-server', enabled: true, tokens: null, price: knownPrice(50) }),
  ]);
  const usage = observedUsage({ foo_bar: 5, 'used-server': 6 });

  const { joinHealth } = buildValveRows({ snapshot, usage });

  assert.equal(joinHealth, 'ok');
});

test('buildValveRows: OxideGate present, snapshot missing -> wire-only rows still render as unknown, carrying real uses, nothing dropped, no recommendation', () => {
  const snapshot = { status: 'unknown', reason: 'missing-file' };
  const usage = observedUsage({ 'server-a': 3, 'server-b': 7 });

  const { rows, joinHealth } = buildValveRows({ snapshot, usage });

  assert.equal(rows.length, 2, 'both wire-observed labels must render; a missing snapshot must not drop them');
  for (const row of rows) {
    assert.equal(row.join, 'unknown');
    assert.equal(row.price, undefined, 'there is no snapshot at all, so there is no price to show');
    assert.equal(row.recommendation.status, 'no-recommendation');
    assert.equal(row.recommendation.reason, 'unattributed-spend');
  }
  assert.equal(rows.find((r) => r.label === 'server-a').uses, 3);
  assert.equal(rows.find((r) => r.label === 'server-b').uses, 7);
  assert.equal(joinHealth, 'ok', 'no snapshot servers exist to disagree with the wire, so nothing can be "no-correspondence"');
});

// =======================================================================
// tools-flattened outranks insufficient-observation.
//
// The two reasons imply OPPOSITE actions. "Not enough observation yet" tells
// the user to keep the session running. Flattening tells them the wire on
// this route cannot carry per-server attribution at all, so running it for a
// week changes nothing. Since the window gate fires first, a valve that
// checks flattening after it would only ever say "wait" — on the exact route
// where waiting is futile.
//
// Found live: OpenCode's /v1/responses puts all 40 tools in one `(native)`
// bucket with `tools_flattened: true`. The MCP tools are in there; nothing
// says which.
// =======================================================================

test('buildValveRows: flattened tools outrank an unfilled window — the permanent reason beats the transient one', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'engram', enabled: true, tokens: 100, price: knownPrice(17233) }),
  ]);
  const usage = { status: 'insufficient-observation', windowMs: 60 * 1000, count: 9, hasFlattenedTools: true };

  const { rows } = buildValveRows({ snapshot, usage });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].recommendation.status, 'no-recommendation');
  assert.equal(
    rows[0].recommendation.reason,
    'tools-flattened',
    'saying "insufficient-observation" here sends the user to wait for an answer that can never arrive',
  );
});

test('buildValveRows: flattening blocks a recommendation even on a FULL window', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'engram', enabled: true, tokens: 100, price: knownPrice(17233) }),
  ]);
  // A filled window that would otherwise produce candidate-to-disable: the
  // server is priced, enabled, and shows zero uses. That zero is exactly the
  // one flattening makes untrustworthy.
  const usage = {
    status: 'observed',
    windowMs: 45 * MINUTE_MS,
    usesByLabel: {},
    hasOthersBucket: false,
    hasFlattenedTools: true,
  };

  const { rows } = buildValveRows({ snapshot, usage });
  assert.notEqual(rows[0].recommendation.status, 'candidate-to-disable', 'a zero from a flattened window is not a zero');
  assert.equal(rows[0].recommendation.reason, 'tools-flattened');
});

test('buildValveRows: without flattening, an unfilled window still says insufficient-observation', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'engram', enabled: true, tokens: 100, price: knownPrice(17233) }),
  ]);
  const usage = { status: 'insufficient-observation', windowMs: 60 * 1000, count: 9, hasFlattenedTools: false };

  const { rows } = buildValveRows({ snapshot, usage });
  assert.equal(rows[0].recommendation.reason, 'insufficient-observation', 'the old reason must survive for the case it describes');
});

test('buildValveRows: con tools aplanadas, `uses` es undefined — un 0 ahí sería fabricado', () => {
  const snapshot = knownSnapshot([
    snapshotServer({ name: 'engram', enabled: true, tokens: 100, price: knownPrice(17233) }),
  ]);
  // Ventana LLENA: sin aplanado, un snapshot-only aquí valdría uses:0, que es
  // una observación legítima ("se midió y no apareció en el cable"). Con las
  // tools aplanadas ese mismo 0 deja de ser una observación: el servidor pudo
  // usarse dentro del bloque que no sabe atribuir. Bloquear la recomendación
  // no basta si la fila sigue IMPRIMIENDO el cero.
  const usage = {
    status: 'observed',
    windowMs: 45 * MINUTE_MS,
    usesByLabel: {},
    hasOthersBucket: false,
    hasFlattenedTools: true,
  };

  const { rows } = buildValveRows({ snapshot, usage });
  assert.equal(rows[0].uses, undefined, 'sin atribución no hay cuenta de usos, ni siquiera cero');
});

// --- Atribución por nombres cuando el cable viene aplanado ---
//
// El techo que documentaba `INFORME-VALVULA-MCP.md` §4. Con `tool_names` en
// el cable (OxideGate#19) y `toolNames` en el snapshot, el cruce es una
// BÚSQUEDA contra verdad de campo, no una heurística de nombres — que es lo
// que OxideGate#5 rechazó con razón.

function flattenedUsage(usesByToolName, { complete = true } = {}) {
  return {
    status: 'observed',
    windowMs: 60 * 60 * 1000,
    usesByLabel: {},
    hasOthersBucket: false,
    hasFlattenedTools: true,
    usesByToolName,
    flattenedNamesComplete: complete,
  };
}

function snapshotWith(servers) {
  return { status: 'known', freshness: 'fresh', timestamp: Date.now(), servers };
}

test('atribuye un nombre aplanado con prefijo del servidor', () => {
  const snapshot = snapshotWith([
    { name: 'engram', price: { status: 'known', bytes: 100 }, toolNames: ['mem_search'] },
  ]);
  const usage = flattenedUsage({ engram_mem_search: 4 });

  const { rows } = buildValveRows({ snapshot, usage });
  const engram = rows.find((r) => r.label === 'engram');

  assert.equal(engram.uses, 4, 'engram_mem_search es de engram');
});

test('un nombre nativo genuino no se atribuye a nadie', () => {
  const snapshot = snapshotWith([
    { name: 'engram', price: { status: 'known', bytes: 100 }, toolNames: ['mem_search'] },
  ]);
  const usage = flattenedUsage({ delegation_list: 7 });

  const { rows } = buildValveRows({ snapshot, usage });
  const engram = rows.find((r) => r.label === 'engram');

  assert.equal(engram.uses, 0, 'delegation_list no casa con ninguna lista MCP');
});

// El fallo que OxideGate#5 temía, y que aquí NO puede ocurrir: partir por `_`
// habría hecho de `delegation` un servidor. El cruce va contra la lista, no
// contra el patrón del nombre.
test('nombres sin nombres en alguna fila mantienen el bloqueo', () => {
  const snapshot = snapshotWith([
    { name: 'engram', price: { status: 'known', bytes: 100 }, toolNames: ['mem_search'] },
  ]);
  const usage = flattenedUsage({ engram_mem_search: 4 }, { complete: false });

  const { rows } = buildValveRows({ snapshot, usage });
  const engram = rows.find((r) => r.label === 'engram');

  assert.equal(engram.uses, undefined, 'atribución incompleta no imprime un cero');
  assert.equal(engram.recommendation.reason, 'tools-flattened');
});

// Un snapshot que no declara sus tools no puede resolver el cruce. `undefined`
// bloquea; `[]` sería la afirmación distinta de "este servidor no tiene tools".
test('un snapshot sin toolNames mantiene el bloqueo', () => {
  const snapshot = snapshotWith([
    { name: 'engram', price: { status: 'known', bytes: 100 } },
  ]);
  const usage = flattenedUsage({ engram_mem_search: 4 });

  const { rows } = buildValveRows({ snapshot, usage });
  const engram = rows.find((r) => r.label === 'engram');

  assert.equal(engram.recommendation.reason, 'tools-flattened');
});

// Si un mismo nombre casa con dos servidores, atribuirlo a uno sería
// inventar. Se bloquea la ventana entera, misma disciplina que una fila sin
// nombres: una atribución parcial se lee como completa si no se declara.
test('un nombre que casa con dos servidores bloquea la atribución', () => {
  const snapshot = snapshotWith([
    { name: 'uno', price: { status: 'known', bytes: 10 }, toolNames: ['comun'] },
    { name: 'dos', price: { status: 'known', bytes: 20 }, toolNames: ['comun'] },
  ]);
  const usage = flattenedUsage({ comun: 3 });

  const { rows } = buildValveRows({ snapshot, usage });

  assert.ok(rows.every((r) => r.recommendation.reason === 'tools-flattened'));
});

test('con la atribución resuelta, un servidor sin usos es candidato', () => {
  const snapshot = snapshotWith([
    { name: 'engram', price: { status: 'known', bytes: 100 }, toolNames: ['mem_search'] },
    { name: 'ocioso', price: { status: 'known', bytes: 50 }, toolNames: ['nunca_usada'] },
  ]);
  const usage = flattenedUsage({ engram_mem_search: 6 });

  const { rows } = buildValveRows({ snapshot, usage });
  const ocioso = rows.find((r) => r.label === 'ocioso');

  assert.equal(ocioso.uses, 0);
  assert.equal(ocioso.recommendation.status, 'candidate-to-disable');
});
