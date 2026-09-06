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
  assertNoFabricatedZeroCost,
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

test('hallazgo 1: publishesEndpoint null (proxy pre-contrato, /version 404) PERO /sessions responde 200 con datos reales -> SE RENDERIZA la tabla, jamás se colapsa null en false', async () => {
  // Sin pasar `version` -> /version 404 -> readProxyVersion 'pre-contract' -> publishesEndpoint null.
  // CON `sessions` -> /sessions 200 real. El único contraejemplo que demuestra
  // que `null` no se trata como `false`: si se colapsara, esta petición jamás
  // se haría y el informe completo (con su fila real) nunca aparecería.
  const mock = await startMockOxideGate({
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.equal(code, 0);
    assert.ok(stdout.includes('SESIONES'));
    assert.ok(stdout.includes('ses_f87dc264'));
    assert.ok(stdout.includes('TOTALES'));
  } finally {
    await mock.close();
  }
});

test('hallazgo 1: publishesEndpoint null por /version inalcanzable (fail de red) también deja pasar la petición real a /sessions', async () => {
  const mock = await startMockOxideGate({
    version: 'fail',
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.equal(code, 0);
    assert.ok(stdout.includes('SESIONES'));
  } finally {
    await mock.close();
  }
});

test('hallazgo 1: publishesEndpoint null por forma inesperada de /version también deja pasar la petición real a /sessions', async () => {
  const mock = await startMockOxideGate({
    version: { contract: 'no-es-un-numero' }, // forma inválida -> unknown -> null
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout, code } = await runSessionsCli({ baseUrl: mock.url });
    assert.equal(code, 0);
    assert.ok(stdout.includes('SESIONES'));
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

test('regla 1: is_session true + cost_usd 0 se imprime como sesión con coste real 0,0000 $ (coma, defecto #2), no como "no atribuible"', async () => {
  const filaConCosteReal0 = { ...FILA_SESION_REAL, key: 'ses_sin_precio', cost_usd: 0 };
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [filaConCosteReal0] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const sesionesBlock = stdout.split('NO ATRIBUIDO')[0];
    assert.ok(sesionesBlock.includes('ses_sin_precio'));
    assert.ok(sesionesBlock.includes('0,0000 $'));
    assert.ok(!sesionesBlock.includes('no atribuible'));
  } finally {
    await mock.close();
  }
});

test('regla 2: el coste de una fila no atribuible NUNCA sale como "0.0000 $" — el hueco del coste no lleva número, sólo la marca', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assertNoFabricatedZeroCost(assert, stdout);
    assert.ok(stdout.includes('no atribuible'));
    const filaBlock = stdout.split('NO ATRIBUIDO')[1].split('EL PEAJE FIJO')[0];
    assert.ok(!filaBlock.includes('0.0000 $'), 'la fila no debe imprimir "0.0000 $"');
    assert.ok(!filaBlock.includes('0,0000 $'), 'la fila no debe imprimir "0,0000 $"');
  } finally {
    await mock.close();
  }
});

test('regla 2 (totales): el total no atribuido NUNCA imprime "0.0000 $" ni "0,0000 $" — sólo la marca en el hueco del coste', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assertNoFabricatedZeroCost(assert, stdout);
    const totalNoAtribuido = stdout.split('\n').find((l) => l.trim().startsWith('total no atribuido'));
    assert.ok(totalNoAtribuido, 'debe existir la línea de total no atribuido');
    assert.ok(!totalNoAtribuido.includes('0.0000 $'));
    assert.ok(!totalNoAtribuido.includes('0,0000 $'));
    assert.ok(totalNoAtribuido.includes('no atribuible'));
  } finally {
    await mock.close();
  }
});

test('el render completo (sesiones reales + no atribuidas) sigue sin fabricar ceros de coste en ningún sitio', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL, FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assertNoFabricatedZeroCost(assert, stdout);
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

// -------------------------------------------------------------- defecto 2

test('defecto 2: el coste se imprime con COMA decimal (es-ES), nunca con punto', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    // 0.883174 -> "0,8832 $", NUNCA "0.8832 $"
    assert.ok(stdout.includes('0,8832 $'), `debe aparecer el coste con coma: ${stdout}`);
    assert.ok(!/\d\.\d{4} ?\$/.test(stdout), 'ningún coste debe llevar punto decimal');
  } finally {
    await mock.close();
  }
});

test('defecto 2 (totales): el total también usa coma decimal, nunca punto', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const totalSesiones = stdout.split('\n').find((l) => l.trim().startsWith('total sesiones'));
    assert.ok(totalSesiones.includes('0,8832 $'));
    assert.ok(!/\d\.\d{4} ?\$/.test(totalSesiones));
  } finally {
    await mock.close();
  }
});

test('defecto 2 (peaje): las kB del producto bytes × seen_in usan coma decimal, nunca punto', async () => {
  // bytes=6839, seen_in=25 -> producto=170975 B -> 171,0 kB (coma, NUNCA "171.0 kB")
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    assert.ok(stdout.includes('171,0 kB'), `debe aparecer la kB con coma: ${stdout}`);
    assert.ok(!/\d+\.\d+ kB/.test(stdout), 'ninguna cifra de kB debe llevar punto decimal');
  } finally {
    await mock.close();
  }
});

// -------------------------------------------------------------- defecto 3

const FILA_SES_MEDIDA = {
  key: 'ses_medida',
  is_session: true,
  source: 'explicit',
  cost_usd: 0.5,
  requests: 10,
  input_tokens: 1000,
  cache_read_tokens: 0,
  output_tokens: 100,
  fixed_toll: { hooks: null, instructions: null, skills: { bytes: 6839, seen_in: 8 } },
};

const FILA_NOATRIB_MEDIDA = {
  key: 'no_atrib_medida',
  is_session: false,
  source: 'unattributed',
  cost_usd: 0,
  requests: 5,
  input_tokens: 500,
  cache_read_tokens: 0,
  output_tokens: 0,
  fixed_toll: { hooks: { bytes: 100, seen_in: 5 }, instructions: null, skills: null },
};

function filaSinMedir(key, isSession) {
  return {
    key,
    is_session: isSession,
    source: isSession ? 'explicit' : 'unattributed',
    cost_usd: isSession ? 0.1 : 0,
    requests: 3,
    input_tokens: 30,
    cache_read_tokens: 0,
    output_tokens: 3,
    fixed_toll: { hooks: null, instructions: null, skills: null },
  };
}

test('defecto 3: las filas con al menos un miembro medido salen detalladas, sesiones antes que no-sesiones; las no medidas se resumen con el recuento exacto', async () => {
  const filas = [
    FILA_SES_MEDIDA,
    FILA_NOATRIB_MEDIDA,
    filaSinMedir('ses_x', true),
    filaSinMedir('no_atrib_y', false),
    filaSinMedir('no_atrib_z', false),
    filaSinMedir('ses_w', true),
  ];
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: filas },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const peajeBlock = stdout.split('EL PEAJE FIJO')[1].split('TOTALES')[0];

    // las medidas salen detalladas
    assert.ok(peajeBlock.includes('ses_medida'));
    assert.ok(peajeBlock.includes('no_atrib_medida'));

    // sesiones antes que no-sesiones entre las medidas
    assert.ok(
      peajeBlock.indexOf('ses_medida') < peajeBlock.indexOf('no_atrib_medida'),
      'la fila de sesión medida debe salir antes que la fila no-sesión medida',
    );

    // las no medidas NO se listan una a una
    assert.ok(!peajeBlock.includes('ses_x'));
    assert.ok(!peajeBlock.includes('no_atrib_y'));
    assert.ok(!peajeBlock.includes('no_atrib_z'));
    assert.ok(!peajeBlock.includes('ses_w'));

    // se resumen con el recuento EXACTO (4 filas sin medir)
    assert.ok(/\b4\b/.test(peajeBlock), 'debe aparecer el número exacto de filas sin medir (4)');
    assert.ok(peajeBlock.includes('no se listan una a una'));
  } finally {
    await mock.close();
  }
});

test('defecto 3: si NINGUNA fila mide nada, el bloque lo dice explícitamente en vez de quedar vacío', async () => {
  const filas = [filaSinMedir('ses_x', true), filaSinMedir('no_atrib_y', false), filaSinMedir('ses_w', true)];
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: filas },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const peajeBlock = stdout.split('EL PEAJE FIJO')[1].split('TOTALES')[0];
    assert.ok(peajeBlock.includes('ninguna'), 'debe decir explícitamente que ninguna fila mide nada');
    assert.ok(/\b3\b/.test(peajeBlock), 'debe mencionar el número exacto de filas (3)');
    assert.ok(!peajeBlock.includes('ses_x'));
  } finally {
    await mock.close();
  }
});

// -------------------------------------------------------------- defecto 4

test('defecto 4: el bloque (b) es una tabla con la misma cabecera de columnas que (a), y la explicación larga sale UNA sola vez, no por fila', async () => {
  const mock = await startMockOxideGate({
    version: CONTRATO_CON_SESSIONS,
    sessions: { saturated: false, sessions: [FILA_SESION_REAL, FILA_NO_ATRIBUIDA_REAL] },
  });
  try {
    const { stdout } = await runSessionsCli({ baseUrl: mock.url });
    const noAtribuidoBlock = stdout.split('NO ATRIBUIDO')[1].split('EL PEAJE FIJO')[0];

    // misma disciplina de tabla que (a): cabecera de columnas
    assert.ok(noAtribuidoBlock.includes('CLAVE'));
    assert.ok(noAtribuidoBlock.includes('TURNOS'));
    assert.ok(noAtribuidoBlock.includes('COSTE'));

    // la explicación larga sale UNA sola vez en todo el stdout (cabecera del bloque)
    const occurrences = (stdout.match(/no es el coste de una sesión/g) || []).length;
    assert.equal(occurrences, 1, 'la coletilla larga debe salir una sola vez, no por fila');

    // la fila en sí no repite la coletilla larga
    const filaLine = noAtribuidoBlock.split('\n').find((l) => l.includes('unattributed'));
    assert.ok(filaLine, 'debe existir la línea de la fila no atribuida');
    assert.ok(!filaLine.includes('no es el coste de una sesión'));
  } finally {
    await mock.close();
  }
});

// -------------------------------------------------------------- fin nuevos tests

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

