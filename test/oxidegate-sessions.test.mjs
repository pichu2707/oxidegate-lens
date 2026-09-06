// test/oxidegate-sessions.test.mjs
//
// CLI-level tests for bin/oxidegate-sessions.mjs — spawns the REAL binary
// (see test/helpers/run-sessions-cli.mjs for why). Unit tests in
// test/session-report.test.mjs already cover the honesty LOGIC; this suite
// covers the honesty SENTENCE — the thing that actually reaches a human.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startMockOxideGate } from './helpers/mock-oxidegate-server.mjs';
import {
  runSessionsCli,
  assertNoFabricatedZeroBytes,
  assertNoUnmarkedZeroCost,
} from './helpers/run-sessions-cli.mjs';

const CONTRATO_CON_SESSIONS = {
  contract: 1,
  endpoints: ['/health', '/stats', '/sessions', '/requests', '/mcp', '/history'],
  fields: ['session'],
  oxidegate: '0.13.0',
};

const CONTRATO_SIN_SESSIONS = {
  contract: 1,
  endpoints: ['/health', '/stats', '/requests'],
  fields: [],
  oxidegate: '0.9.0',
};

// Fila real medida (anonimizada) contra un proxy 0.13.0 — issue #18.
const FILA_SESION_REAL = {
  key: 'ses_f87dc264',
  is_session: true,
  source: 'explicit',
  cost_usd: 0.883174,
  requests: 26,
  input_tokens: 735589,
  cache_read_tokens: 0,
  output_tokens: 4200,
  fixed_toll: { hooks: null, instructions: null, skills: { bytes: 6839, seen_in: 25 } },
};

const FILA_NO_ATRIBUIDA_REAL = {
  key: 'unattributed',
  is_session: false,
  source: 'unattributed',
  cost_usd: 0,
  requests: 35,
  input_tokens: 400919,
  cache_read_tokens: 0,
  output_tokens: 0,
  fixed_toll: { hooks: null, instructions: null, skills: null },
};

test('--help imprime la ayuda y sale con 0, sin tocar la red', async () => {
  const { stdout, code } = await runSessionsCli({ baseUrl: 'http://127.0.0.1:1', args: ['--help'] });
  assert.equal(code, 0);
  assert.ok(stdout.includes('oxidegate-sessions'));
  assert.ok(stdout.includes('--since'));
});

test('publishesEndpoint false: el proxy declaró su contrato SIN /sessions -> mensaje de actualizar, JAMÁS una tabla vacía', async () => {
  const mock = await startMockOxideGate({ version: CONTRATO_SIN_SESSIONS, sessions: { saturated: false, sessions: [] } });
  try {
    const { stdout, stderr, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('no publica /sessions'));
    assert.ok(stderr.includes('actualiza'));
    // La puerta cortó ANTES de renderizar: no debe haber ni rastro de las
    // secciones del informe, aunque el mock sí tenía datos de sobra.
    assert.ok(!stdout.includes('SESIONES'));
    assert.ok(!stdout.includes('TOTALES'));
  } finally {
    await mock.close();
  }
});

test('publishesEndpoint null (proxy pre-contrato) + 404 real en /sessions -> mismo mensaje de actualizar, nunca un `false` disfrazado', async () => {
  // Sin pasar `version`, el mock responde 404 en /version -> pre-contract -> null.
  // Sin pasar `sessions`, el mock responde 404 en /sessions -> el intento real confirma la ausencia.
  const mock = await startMockOxideGate({});
  try {
    const { stderr, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('no publica /sessions'));
    assert.ok(stderr.includes('actualiza'));
  } finally {
    await mock.close();
  }
});

test('publishesEndpoint true: se pide /sessions y se renderiza el informe completo', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL, FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.equal(code, 0);
    assert.ok(stdout.includes('SESIONES'));
    assert.ok(stdout.includes('NO ATRIBUIDO'));
    assert.ok(stdout.includes('PEAJE FIJO'));
    assert.ok(stdout.includes('TOTALES'));
  } finally {
    await mock.close();
  }
});

test('las filas is_session:false JAMÁS aparecen en el bloque (a) ni se rankean junto a las sesiones', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL, FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const sesionesBlock = stdout.split('NO ATRIBUIDO')[0];
    assert.ok(!sesionesBlock.includes('unattributed'), 'la fila no-sesión no debe aparecer antes del bloque (b)');
  } finally {
    await mock.close();
  }
});

test('regla 1: is_session true + cost_usd 0 se imprime como sesión con coste real 0.0000 $, no como "no atribuible"', async () => {
  const filaConCosteReal0 = { ...FILA_SESION_REAL, key: 'ses_sin_precio', cost_usd: 0 };
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [filaConCosteReal0] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const sesionesBlock = stdout.split('NO ATRIBUIDO')[0];
    assert.ok(sesionesBlock.includes('ses_sin_precio'));
    assert.ok(sesionesBlock.includes('0.0000 $'));
    assert.ok(!sesionesBlock.includes('no atribuible'));
  } finally {
    await mock.close();
  }
});

test('regla 2: el coste de una fila no atribuible NUNCA sale como "0.0000 $" desnudo — siempre con la marca en la misma línea', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assertNoUnmarkedZeroCost(assert, stdout);
    assert.ok(stdout.includes('no atribuible'));
  } finally {
    await mock.close();
  }
});

test('regla 3: un miembro null de fixed_toll se imprime "no medido", jamás "0 B"', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assertNoFabricatedZeroBytes(assert, stdout);
    assert.ok(stdout.includes('no medido'));
  } finally {
    await mock.close();
  }
});

test('regla del N²: el peaje fijo conocido con turnos conocidos imprime el producto bytes × seen_in', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assert.ok(stdout.includes('6.839'));
    assert.ok(stdout.includes('25 turnos'));
    assert.ok(stdout.includes('repetidos'));
  } finally {
    await mock.close();
  }
});

test('sessions: [] real -> "no hay sesiones registradas", nunca un error de lectura', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.equal(code, 0);
    assert.ok(stdout.includes('no hay sesiones registradas'));
  } finally {
    await mock.close();
  }
});

test('saturated: true marca los totales como cota inferior, EN LA MISMA línea del total', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: true, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assert.ok(stdout.includes('SATURADO'));
    const lines = stdout.split('\n').filter((l) => l.trim().startsWith('total '));
    assert.ok(lines.length > 0, 'debe haber al menos una línea de total');
    for (const line of lines) {
      assert.ok(line.includes('cota inferior'), `la línea de total debe marcar la saturación: ${line}`);
    }
  } finally {
    await mock.close();
  }
});

test('totales: si una fila calla un campo, el total de ESE campo es "desconocido", no una suma parcial', async () => {
  const filaSinInputTokens = { ...FILA_SESION_REAL, key: 'ses_incompleta', input_tokens: undefined };
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL, filaSinInputTokens] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const totalSesiones = stdout.split('\n').find((l) => l.trim().startsWith('total sesiones'));
    assert.ok(totalSesiones.includes('entrada=desconocido'));
  } finally {
    await mock.close();
  }
});

// -------------------------------------------------------------------- --since

test('--since válido se manda al proxy y la ventana aplicada sale en la cabecera', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url, args: ['--since', '7d'] });
    assert.equal(code, 0);
    assert.ok(stdout.includes('desde 7d'));
  } finally {
    await mock.close();
  }
});

test('sin --since la cabecera dice que la ventana es todo lo que el proxy retiene', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assert.ok(stdout.includes('todo lo que el proxy retiene'));
  } finally {
    await mock.close();
  }
});

test('--since inválido: el proxy responde 400 y este comando imprime EXACTAMENTE ese mensaje, sale con código distinto de 0, sin reventar', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [] },
  });
  try {
    const { stdout, stderr, code } = await runSessionsCli({ baseUrl: mock.url, args: ['--since', 'manzana'] });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('since=manzana'));
    assert.ok(stderr.includes('YYYY-MM-DD'));
    // Ni tabla vacía ni reventón: nada de las secciones del informe salió.
    assert.ok(!stdout.includes('SESIONES'));
  } finally {
    await mock.close();
  }
});

test('--since con fecha YYYY-MM-DD también es válido para el mock (mismo contrato que /stats)', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url, args: ['--since', '2026-01-01'] });
    assert.equal(code, 0);
    assert.ok(stdout.includes('desde 2026-01-01'));
  } finally {
    await mock.close();
  }
});
