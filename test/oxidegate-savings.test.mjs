// test/oxidegate-savings.test.mjs
//
// Regression suite for bin/oxidegate-savings.mjs.
//
// This tool went through NINE adversarial review rounds. Nine defects were
// found. Every single one was found by a human or an agent reading and
// MEASURING the printed stdout — not one was caught by a machine, because
// until this file existed there was no machine. Every test below turns one
// of those nine defects into an assertion that fails if it comes back. That
// is the entire point of this file — not coverage percentage, regression
// protection for a specific, known, expensive list of bugs. See README.md
// ("Por qué existe esta suite") before deleting any test in here.
//
// Every test spawns the REAL bin/oxidegate-savings.mjs against a throwaway
// HTTP server (ephemeral port) and, where needed, a throwaway fake `claude`
// (own PATH, never the host's) — see test/helpers/*.mjs for why.

import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { startMockOxideGate } from './helpers/mock-oxidegate-server.mjs';
import { makeFakeClaude } from './helpers/fake-claude.mjs';
import { makeFakeSnapshot } from './helpers/fake-snapshot.mjs';
import {
  runSavingsCli,
  assertNoDeadCausalArtifacts,
  assertNoUnwindowedRecommendation,
  assertNoFabricatedZero,
  assertNoDroppedSpend,
} from './helpers/run-savings-cli.mjs';

function baseEntry(overrides = {}) {
  return {
    timestamp: '2026-07-12T15:24:29.525525732+00:00',
    model: 'claude-test-model',
    upstream: 'anthropic',
    client: 'claude-cli/2.1.207 (external, sdk-cli)',
    tools_by_server: [],
    context_tools_bytes: null,
    tools_overhead_bytes: null,
    ...overrides,
  };
}

/** The line the table prints for a given server — independent of column widths. */
function lineFor(stdout, serverName) {
  return stdout.split('\n').find((l) => l.startsWith(serverName));
}

/** A fake `claude` that reports a genuine, KNOWN zero — never used to mean "unknown". */
async function knownZeroClaude() {
  return makeFakeClaude({ stdout: 'No MCP servers configured.\n' });
}

// =======================================================================
// Defecto #1 — un booleano "diferido" a nivel body NUNCA es la verdad de
// bytes de OTRO servidor. Mezcla mal: imprimir "nada más que ahorrar"
// arriba de una tabla que muestra bytes reales de otro servidor.
// =======================================================================

test('defecto 1: una fila totalmente diferida y una NO diferida reciben el MISMO veredicto de bytes', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'server_a', kind: 'mcp', tools: 3, bytes: 300, deferred_tools: 3 },
          { server: 'server_b', kind: 'mcp', tools: 2, bytes: 200, deferred_tools: 0 },
        ],
        context_tools_bytes: 500,
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  const lineA = lineFor(stdout, 'server_a');
  const lineB = lineFor(stdout, 'server_b');
  assert.ok(lineA?.includes('sí, desconectándolo'), `fila server_a: ${lineA}`);
  assert.ok(lineB?.includes('sí, desconectándolo'), `fila server_b: ${lineB}`);

  // El bug real: un booleano a nivel body hacía imprimir esta frase aunque
  // server_b (sin diferir nada) tuviera bytes reales sobre la mesa.
  assert.ok(
    !stdout.includes('nada que quitar en bytes'),
    'no debe decir "nada que quitar" habiendo 2 servidores mcp con bytes reales',
  );
  assertNoDeadCausalArtifacts(assert, stdout);
});

// =======================================================================
// Defecto #2 — el error de categoría: `deferred_tools` es un hecho de
// TOKENS DE CONTEXTO y nunca debe influir un veredicto de BYTES. Medido:
// marcar una tool `defer_loading` cuesta 21 bytes y no quita ninguno.
// =======================================================================

test('defecto 2: ¿SE PUEDE QUITAR? para kind mcp es "sí, desconectándolo" sin importar deferred_tools (0, parcial, total)', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'srv_none', kind: 'mcp', tools: 2, bytes: 111, deferred_tools: 0 },
          { server: 'srv_partial', kind: 'mcp', tools: 2, bytes: 222, deferred_tools: 1 },
          { server: 'srv_full', kind: 'mcp', tools: 4, bytes: 333, deferred_tools: 4 },
        ],
        context_tools_bytes: 666,
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  for (const [server, bytes] of [
    ['srv_none', '111 B'],
    ['srv_partial', '222 B'],
    ['srv_full', '333 B'],
  ]) {
    const line = lineFor(stdout, server);
    assert.ok(line, `debería haber una fila para ${server}`);
    assert.ok(line.includes('sí, desconectándolo'), `fila ${server}: ${line}`);
    // La fila totalmente diferida (srv_full) debe mostrar sus bytes REALES,
    // sin recortar — deferred_tools nunca reduce lo que se imprime en BYTES.
    assert.ok(line.includes(bytes), `fila ${server} debería mostrar ${bytes} sin recortar: ${line}`);
  }

  // Ninguna fila mcp totalmente diferida puede describirse como liviana,
  // barata o "en el piso" — esa es exactamente la conclusión categorial
  // errónea que el defecto #2 introducía.
  for (const forbidden of ['liviano', 'barato', 'económico', 'mínimo', 'el piso', 'ligero']) {
    assert.ok(!stdout.toLowerCase().includes(forbidden), `no debería aparecer "${forbidden}"`);
  }
  assertNoDeadCausalArtifacts(assert, stdout);
});

// =======================================================================
// Defecto #3 y #4 — nunca CONCLUIR una causa; `client` (User-Agent) es
// contenido del cliente, no verificable, y nunca decide un veredicto.
// =======================================================================

test('defectos 3 y 4: mismo entry con dos `client` distintos -> tabla y veredictos IDÉNTICOS; ausencia con las DOS causas, ninguna elegida', async () => {
  const claude = await makeFakeClaude({
    stdout:
      'avail_one: cmd - ✔ Connected\n' +
      'avail_two: cmd - ✔ Connected\n' +
      'avail_three: cmd - ✔ Connected\n' +
      'avail_four: cmd - ✔ Connected\n',
  });

  const buildRequests = () => [
    baseEntry({
      client: undefined, // set per-run below
      tools_by_server: [{ server: 'avail_four', kind: 'mcp', tools: 1, bytes: 91, deferred_tools: 0 }],
      context_tools_bytes: 91,
    }),
  ];

  const mock1 = await startMockOxideGate({
    requests: [{ ...buildRequests()[0], client: 'claude-cli/2.1.207 (external, sdk-cli)' }],
    stats: [],
  });
  const run1 = await runSavingsCli({ baseUrl: mock1.url, claudePath: claude.path });
  await mock1.close();

  const mock2 = await startMockOxideGate({
    requests: [{ ...buildRequests()[0], client: 'curl/8.21.0 pretending to be claude-cli/9.9.9' }],
    stats: [],
  });
  const run2 = await runSavingsCli({ baseUrl: mock2.url, claudePath: claude.path });
  await mock2.close();
  await claude.cleanup();

  assert.equal(run1.code, 0);
  assert.equal(run2.code, 0);

  // Sólo la primera línea ("fuente: ... cliente: ...") puede diferir
  // legítimamente. El dashboard factual también imprime `client`; se
  // normaliza ese valor y todo lo demás — tabla, veredictos, texto de
  // ausencia — tiene que ser byte-por-byte idéntico: el header `client`
  // nunca decide.
  // El segundo reemplazo se detiene en el próximo separador de campo (dos
  // espacios), no en el literal "  upstream=": la fixture de este test no
  // trae `route`, así que hoy "cliente=" cae pegado a "  upstream=" y ambas
  // formas coinciden. Pero si alguien agrega `route` a esta fixture más
  // adelante, un `.*?` que sólo sabe parar en "  upstream=" se comería
  // "ruta=..." dentro del placeholder — y el invariante byte-a-byte que este
  // test protege dejaría de comparar esa parte del texto sin que nadie lo
  // note. Parar en el separador de campo evita que el placeholder cruce a un
  // campo vecino sin importar cuál sea.
  const normalizeClient = (text) =>
    text
      .replace(/cliente: .*\n/, 'cliente: <client>\n')
      .replace(/cliente=(?:(?!  ).)*/, 'cliente=<client>');
  assert.equal(normalizeClient(run1.stdout), normalizeClient(run2.stdout));

  for (const { stdout } of [run1, run2]) {
    // Ausencia: se nombran las DOS causas posibles, ninguna elegida.
    assert.ok(
      stdout.includes('Puede ser que tu harness los esté reteniendo, o que todavía no hayan conectado'),
      'debe nombrar ambas causas posibles de ausencia, sin elegir una',
    );
    assert.ok(stdout.includes('ninguna de las dos causas se puede confirmar'));
    assert.ok(stdout.includes('avail_one') && stdout.includes('avail_two') && stdout.includes('avail_three'));
    assertNoDeadCausalArtifacts(assert, stdout);
  }
});

// =======================================================================
// Defecto #5 — ausente ≠ cero, en TELEMETRÍA: una fila de un proxy viejo
// sin `deferred_tools` es DESCONOCIDO, nunca "0 diferidas".
// =======================================================================

test('defecto 5: fila mcp sin `deferred_tools` se reporta como "desconocido", NUNCA como "0 diferidas"', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: 'legacy_srv', kind: 'mcp', tools: 2, bytes: 150 }], // sin deferred_tools
        context_tools_bytes: 150,
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  const contextLine = stdout.split('\n').find((l) => l.trim().startsWith('- legacy_srv:'));
  assert.ok(contextLine, 'debería haber una línea de contexto para legacy_srv');
  assert.ok(contextLine.includes('desconocido'), `línea: ${contextLine}`);
  assert.ok(!contextLine.includes('0 tools diferidas'), `no debe leer ausente como cero: ${contextLine}`);
  assert.ok(!contextLine.includes('0/2'), `no debe leer ausente como cero: ${contextLine}`);
});

// =======================================================================
// Defecto #6 — ausente ≠ cero, en CONFIG: cada modo de fallo de `claude`
// es "no sé", estructuralmente distinto de un cero genuino.
// =======================================================================

test('defecto 6: "claude" no está en el PATH -> "no se pudo leer", nunca "0 disponibles"', async () => {
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: '(native)', kind: 'native', tools: 1, bytes: 50 }],
        context_tools_bytes: 50,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: null });
  await mock.close();

  assert.equal(code, 0);
  assert.ok(stdout.includes('no se encontró el comando `claude` en el PATH'));
  assert.ok(stdout.includes('DISTINTO de "0 servidores disponibles"'));
});

test('defecto 6: "claude mcp list" sale con código != 0 -> "no se pudo leer", nunca "0 disponibles"', async () => {
  const claude = await makeFakeClaude({ exitCode: 1, stdout: 'boom' });
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: '(native)', kind: 'native', tools: 1, bytes: 50 }],
        context_tools_bytes: 50,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('`claude mcp list` devolvió un error'));
  assert.ok(stdout.includes('DISTINTO de "0 servidores disponibles"'));
});

test('defecto 6: salida de "claude mcp list" con formato inesperado -> "no se pudo leer", nunca "0 disponibles"', async () => {
  const claude = await makeFakeClaude({ stdout: 'salida totalmente inesperada\n' });
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: '(native)', kind: 'native', tools: 1, bytes: 50 }],
        context_tools_bytes: 50,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('la salida de `claude mcp list` no tuvo el formato esperado'));
  assert.ok(stdout.includes('DISTINTO de "0 servidores disponibles"'));
});

test('defecto 6: 0 servidores configurados de verdad -> "nada que restar", texto DISTINTO del caso "no se pudo leer"', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: '(native)', kind: 'native', tools: 1, bytes: 50 }],
        context_tools_bytes: 50,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('no tienes servidores MCP disponibles: nada que restar aquí.'));
  // El cero genuino jamás usa el lenguaje de "no se pudo leer".
  assert.ok(!stdout.includes('no se pudo leer'));
  assert.ok(!stdout.includes('DISTINTO de "0 servidores disponibles"'));
});

// =======================================================================
// Defecto #7 — sanitizeServerName() no es inyectiva: nombres que colisionan
// se excluyen de disponibles/faltantes y se reportan como ambigüedad.
// =======================================================================

test('defecto 7: colisión de 2 nombres ("foo bar" / "foo_bar") se reporta como ambigüedad, nunca se fusiona en silencio', async () => {
  const claude = await makeFakeClaude({
    stdout: 'foo bar: cmd - ✔ Connected\nfoo_bar: cmd - ✔ Connected\nbaz: cmd - ✔ Connected\n',
  });
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'foo_bar', kind: 'mcp', tools: 1, bytes: 50, deferred_tools: 0 },
          { server: 'baz', kind: 'mcp', tools: 1, bytes: 60, deferred_tools: 0 },
        ],
        context_tools_bytes: 110,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(
    stdout.includes('no se puede saber si llegaron "foo bar" y "foo_bar"'),
    'debe nombrar la colisión explícitamente',
  );
  assert.ok(stdout.includes('sanitizan al mismo nombre en el cable ("foo_bar")'));
  // Sólo "baz" es contable con certeza: los ambiguos quedan afuera de ambos
  // conteos (disponibles y faltantes) — nunca "2 disponibles" ni fusionados.
  assert.ok(stdout.includes('Tienes 1 servidor(es) MCP disponibles (sin contar los ambiguos de arriba)'));
});

test('defecto 7: colisión de 3 nombres se reporta con los TRES nombres, nunca se pierde ninguno', async () => {
  const claude = await makeFakeClaude({
    stdout:
      'foo bar: cmd - ✔ Connected\n' +
      'foo_bar: cmd - ✔ Connected\n' +
      'foo!bar: cmd - ✔ Connected\n' +
      'qux: cmd - ✔ Connected\n',
  });
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: 'qux', kind: 'mcp', tools: 1, bytes: 70, deferred_tools: 0 }],
        context_tools_bytes: 70,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('no se puede saber si llegaron "foo bar" y "foo_bar" y "foo!bar"'));
  assert.ok(stdout.includes('Tienes 1 servidor(es) MCP disponibles (sin contar los ambiguos de arriba)'));
});

// =======================================================================
// Defecto #8 — el bucket (others): un "faltante" con fila (others) presente
// puede en realidad haber llegado, fundido y sin nombre, adentro.
// =======================================================================

test('defecto 8: con fila (others) presente, un servidor sin fila propia se reporta como NO CONFIRMADO, nunca como ausente', async () => {
  const claude = await makeFakeClaude({
    stdout: 'avail_a: cmd - ✔ Connected\navail_b: cmd - ✔ Connected\n',
  });
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'avail_a', kind: 'mcp', tools: 1, bytes: 40, deferred_tools: 0 },
          { server: '(others)', kind: 'others', tools: 5, bytes: 900 },
        ],
        context_tools_bytes: 940,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('avail_b'));
  assert.ok(
    // La frase real envuelve una línea entre "No" y "se puede confirmar"
    // (impresión con ancho fijo) — se busca la parte que no cruza el salto.
    stdout.includes('se puede confirmar si alguno de estos está adentro de "(others)"'),
    'con (others) presente, debe decir "no confirmado", no "no llegó"',
  );
  assert.ok(!stdout.includes('no viajan ahora mismo'), 'no debe afirmar ausencia cuando hay bucket (others)');
});

test('defecto 8 (contraste): SIN fila (others), un servidor sin fila propia SÍ se reporta como no viajando', async () => {
  const claude = await makeFakeClaude({
    stdout: 'avail_a: cmd - ✔ Connected\navail_b: cmd - ✔ Connected\n',
  });
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: 'avail_a', kind: 'mcp', tools: 1, bytes: 40, deferred_tools: 0 }],
        context_tools_bytes: 40,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('no viajan ahora mismo'));
  assert.ok(!stdout.includes('no se puede confirmar si alguno de estos está adentro de "(others)"'));
});

// =======================================================================
// Defecto #9 — la nota de cierre sobre filas `native` no debe imprimirse
// si la tabla no tiene ninguna fila `native` en pantalla.
// =======================================================================

test('defecto 9: sin fila native en la tabla, NO se imprime la nota sobre filas native', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: 'srv1', kind: 'mcp', tools: 1, bytes: 50, deferred_tools: 0 }],
        context_tools_bytes: 50,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(!stdout.includes('Las filas `native` no se quitan'));
});

test('defecto 9: con fila native en la tabla, SÍ se imprime la nota sobre filas native', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'srv1', kind: 'mcp', tools: 1, bytes: 50, deferred_tools: 0 },
          { server: '(native)', kind: 'native', tools: 2, bytes: 80 },
        ],
        context_tools_bytes: 130,
      }),
    ],
    stats: [],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('Las filas `native` no se quitan'));
});

// =======================================================================
// Defecto #10 — ausente ≠ cero, en TOTALES: la línea `tools:` del
// dashboard sumaba `tools_by_server` con `?? 0`, que convierte un campo
// AUSENTE en una fila (nadie reportó ese dato) en el mismo cero que un
// campo genuinamente medido en cero. El mismo criterio que ya aplican
// `humanizeBytes()` y `classifyRowContext` campo a campo se extiende aquí: CERO
// FILAS es un cero real y conocido (no hay nada ni nadie de quien
// callarse); pero UNA fila que no trae el campo es SILENCIO sobre esa
// fila puntual, y ese silencio envenena SÓLO el total de ESE campo — el
// otro total, y el resto del dashboard, siguen intactos.
//
// La fila con `tools_by_server: []` genuinamente vacío es, hoy,
// inalcanzable a través de la CLI real: `newestBreakdown()` (más arriba
// en este archivo) ya descarta cualquier entry con `tools_by_server`
// vacío ANTES de llegar a `writeRequestDashboard` — ver su propio
// comentario ("no es una fuente usable, se salta en vez de reportarse
// como 'cero servidores'"). Por eso no hay aquí un test de "0 filas
// reales" contra el binario: sería un test que no puede fallar ni pasar
// por la vía pública, y este archivo no fabrica escenarios que no puede
// producir de verdad. Lo que SÍ es alcanzable — y es lo que importa para
// el defecto real — es que una suma de valores PRESENTES en 0 se siga
// imprimiendo como 0, nunca como '-'; y que una fila sin el campo
// envenene sólo ESE total, nunca el otro. Eso es lo que prueban los tres
// tests de abajo.
// =======================================================================

test('defecto 10: fila con tools=0 y bytes=0 presentes -> total real 0, nunca "-"', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [{ server: 'vacio', kind: 'mcp', tools: 0, bytes: 0 }],
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(
    stdout.includes('tools: filas=1  tools=0  bytes=0 B'),
    `un 0 medido de verdad debe imprimirse como 0, no como "-": ${stdout}`,
  );
});

test('defecto 10: una fila sin `bytes` envenena SÓLO el total de bytes, nunca el de tools', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'a', kind: 'mcp', tools: 5, bytes: 100 },
          { server: 'b', kind: 'mcp', tools: 3 }, // sin bytes: silencio, no cero
        ],
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(
    stdout.includes('tools: filas=2  tools=8  bytes=-'),
    `bytes debe ser "-" (b no lo reportó) pero tools=8 (las dos filas lo reportaron): ${stdout}`,
  );
  // El bug real: imprimir la suma PARCIAL (100, sólo lo que reportó `a`) como
  // si fuera el total medido de las dos filas.
  assert.ok(
    !stdout.includes('bytes=100 B'),
    'no debe imprimir la suma parcial (100) como si fuera el total de bytes',
  );
});

test('defecto 10: una fila sin `tools` envenena SÓLO el total de tools, nunca el de bytes', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: 'a', kind: 'mcp', tools: 5, bytes: 100 },
          { server: 'b', kind: 'mcp', bytes: 50 }, // sin tools: silencio, no cero
        ],
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(
    stdout.includes('tools: filas=2  tools=-  bytes=150 B'),
    `tools debe ser "-" (b no lo reportó) pero bytes=150 (las dos filas lo reportaron): ${stdout}`,
  );
});

// =======================================================================
// Cobertura adicional (revisión adversarial, ramas de writeRequestDashboard
// nunca ejercitadas por los tests de arriba) — no son los nueve defectos
// numerados, pero son la misma disciplina: un valor real que el filtro
// `present()` deja pasar, o una ausencia que el propio código trata de dos
// formas DISTINTAS, tienen que quedar fijados en una aserción.
// =======================================================================

test('dashboard factual: valores falsy REALES (stream=false, 0) sobreviven el filtro present(), nunca se leen como ausentes', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        stream: false,
        output_tokens: 0,
        ttft_ms: 0,
        total_ms: 5,
        tools_by_server: [{ server: 'srv', kind: 'mcp', tools: 1, bytes: 10 }],
        context_tools_bytes: 10,
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  // present() sólo rechaza null/undefined — `false` y `0` son hechos
  // medidos, no ausencias. Una "simplificación" a `if (value)` los borraría
  // en silencio.
  assert.ok(stdout.includes('stream=false'), `stream=false real debe imprimirse, no omitirse: ${stdout}`);
  assert.ok(stdout.includes('output=0'), `output_tokens=0 real debe imprimirse, no omitirse: ${stdout}`);
  assert.ok(stdout.includes('ttft_ms=0'), `ttft_ms=0 real debe imprimirse, no omitirse: ${stdout}`);
});

// Lo de abajo documenta el comportamiento ACTUAL, no lo endosa: hay dos
// formas distintas de decir "no hay dato" en este dashboard, y hoy son
// inconsistentes entre sí.
//   - Pares de valor crudo (ttft_ms, total_ms, prepare_us, status, etc.):
//     ausente -> present() los rechaza -> el par se OMITE de la línea. Si
//     TODOS los pares de una línea están ausentes, metricLine devuelve ''
//     y la línea entera desaparece.
//   - Pares en bytes (system, tools, history, last_turn, other, measured,
//     el total `bytes`): ausente -> humanizeBytes() devuelve la cadena '-',
//     que SÍ pasa present() -> el par SIEMPRE se imprime, como `campo=-`.
// Omisión y '-' son dos maneras distintas de decir "no hay dato"; unificarlas
// es una decisión abierta, no algo que este test resuelva.
test('dashboard factual: campo crudo ausente se OMITE de su línea (o hace desaparecer la línea entera); campo en bytes ausente imprime "-"', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        // Deliberadamente SIN ttft_ms/total_ms/prepare_us (los tres pares de
        // "latencia") ni status (par crudo de "identidad") ni
        // context_history_bytes (par en bytes de "contexto_bytes").
        tools_by_server: [{ server: 'srv', kind: 'mcp', tools: 1, bytes: 10 }],
        context_tools_bytes: 500,
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(
    !stdout.includes('latencia:'),
    `sin ttft_ms/total_ms/prepare_us la línea "latencia:" completa debe desaparecer: ${stdout}`,
  );
  assert.ok(
    !stdout.includes('status='),
    `status ausente debe omitirse de la línea, nunca imprimirse vacío/undefined/NaN: ${stdout}`,
  );
  assert.ok(
    stdout.includes('history=-'),
    `context_history_bytes ausente debe imprimirse como history=-, nunca omitirse: ${stdout}`,
  );
});

test('caveat de filas native NO se imprime cuando también hay una fila mcp real (caso mixto)', async () => {
  const claude = await knownZeroClaude();
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        tools_by_server: [
          { server: '(native)', kind: 'native', tools: 2, bytes: 80 },
          { server: 'srv_mcp', kind: 'mcp', tools: 1, bytes: 40, deferred_tools: 0 },
        ],
        context_tools_bytes: 120,
      }),
    ],
    stats: [],
  });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  // Con una fila mcp real presente, los bytes SÍ están atribuidos por
  // servidor concreto; el caveat de "no hay desglose por MCP" sería falso.
  assert.ok(
    !stdout.includes('No hay desglose por MCP en esta fila.'),
    `caveat no debe aparecer habiendo una fila mcp real junto a la native: ${stdout}`,
  );
});

// =======================================================================
// Protección adicional (no un defecto pasado, uno esperando pasar): el
// camino "harness eager" (upstream !== 'anthropic') tiene que seguir
// diciendo el ahorro DIRECTO y sin cobertura de duda — nueve rondas de
// hedging hacen que sobre-corregir sea el próximo fallo más probable.
// =======================================================================

test('upstream no-anthropic: no usa deferred_tools para concluir carga diferida/inmediata', async () => {
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        upstream: 'openai',
        model: 'gpt-4o',
        client: 'curl/8.21.0',
        tools_by_server: [{ server: 'srv', kind: 'mcp', tools: 1, bytes: 100, deferred_tools: 0 }],
        context_tools_bytes: 100,
      }),
    ],
    stats: [],
  });
  // PATH vacío a propósito: si este camino alguna vez intentara llamar
  // `claude mcp list` (no debería, es sólo para tráfico `anthropic`), el
  // spawn fallaría fuerte en vez de colarse silenciosamente.
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: null });
  await mock.close();

  assert.equal(code, 0);
  assert.ok(
    stdout.includes(
      'Este reporte no usa `deferred_tools` para decidir ahorro en tráfico openai:\n' +
        'la tabla de bytes sólo dice qué filas MCP llegaron en esta petición. No concluye si el\n' +
        'harness cargó herramientas de forma diferida o inmediata.',
    ),
  );
  for (const hedge of ['no se puede confirmar', 'puede ser que', 'tal vez', 'quizás', 'aviso: algunos harnesses']) {
    assert.ok(!stdout.toLowerCase().includes(hedge.toLowerCase()), `no debería aparecer "${hedge}" en tráfico no-anthropic`);
  }
  // Los bloques (b) y (c) son exclusivos de anthropic: no deben aparecer.
  assert.ok(!stdout.includes('servidor(es) MCP disponibles'));
  assert.ok(!stdout.includes('tokens de contexto'));
  assertNoDeadCausalArtifacts(assert, stdout);
});

test('pi/Codex: imprime dashboard factual desde /requests sin atribución MCP ni verdad de carga', async () => {
  const mock = await startMockOxideGate({
    requests: [
      baseEntry({
        client: 'pi (linux 6.19.13+parrot7-amd64; x64)',
        route: '/v1/codex/responses',
        upstream: 'codex',
        status: 200,
        model: 'gpt-5.5',
        stream: true,
        input_tokens: 20192,
        output_tokens: 6,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        context_system_bytes: 31267,
        context_tools_bytes: 72570,
        context_history_bytes: 0,
        context_last_turn_bytes: 71,
        context_other_bytes: 152,
        context_measured_bytes: 104060,
        context_messages_count: 1,
        context_tax_ratio: 0.9978570055737075,
        tools_by_server: [{ server: '(native)', kind: 'native', tools: 46, bytes: 72523, deferred_tools: 0 }],
        tools_overhead_bytes: 47,
        ttft_ms: 4322,
        total_ms: 4895,
        prepare_us: 4648,
      }),
    ],
    // Deliberately different aggregate data: request-level dashboard must not
    // borrow facts from /stats, which can include unrelated concurrent traffic.
    stats: [{ upstream: 'codex', model: 'gpt-5.5', requests: 999 }],
  });
  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: null });
  await mock.close();

  assert.equal(code, 0);
  assert.ok(stdout.includes('petición reciente (/requests, no /stats):'));
  assert.ok(stdout.includes('cliente=pi (linux 6.19.13+parrot7-amd64; x64)'));
  assert.ok(stdout.includes('ruta=/v1/codex/responses'));
  assert.ok(stdout.includes('upstream=codex'));
  assert.ok(stdout.includes('modelo=gpt-5.5'));
  assert.ok(stdout.includes('status=200'));
  assert.ok(stdout.includes('stream=true'));
  assert.ok(stdout.includes('input=20192'));
  assert.ok(stdout.includes('output=6'));
  assert.ok(stdout.includes('cache_read=0'));
  assert.ok(stdout.includes('system=31.3 kB'));
  assert.ok(stdout.includes('tools=72.6 kB'));
  assert.ok(stdout.includes('measured=104.1 kB'));
  assert.ok(stdout.includes('messages=1'));
  assert.ok(stdout.includes('tax_ratio=99.79%'));
  assert.ok(stdout.includes('tools: filas=1  tools=46  bytes=72.5 kB  overhead=47 B'));
  assert.ok(stdout.includes('latencia: ttft_ms=4322  total_ms=4895  prepare_us=4648'));
  assert.ok(stdout.includes('no trae filas MCP individuales'));
  assert.ok(stdout.includes('no atribuyen bytes'));
  assert.ok(stdout.includes('No hay desglose por MCP en esta fila.'));
  assert.ok(stdout.includes('no hay servidores MCP en esta petición: nada que quitar en bytes.'));
  assert.ok(!stdout.includes('ya re-enviados en 999'), 'no debe usar /stats para el dashboard pi');
  assert.ok(!stdout.includes('tokens de contexto'), 'Codex/pi no debe imprimir verdad de deferred_tools como contexto');
  assert.ok(!stdout.toLowerCase().includes('eager'), 'no debe concluir carga eager para pi/Codex');
  assert.ok(!stdout.toLowerCase().includes('lazy'), 'no debe concluir carga lazy para pi/Codex');
  assertNoDeadCausalArtifacts(assert, stdout);
});

test('"no ha visto peticiones" nombra a QUIÉN le preguntó', async () => {
  // Esta frase describía dos situaciones incompatibles: el proxy correcto
  // sin tráfico, y un okupa en el puerto contestando cualquier cosa. La
  // primera es normal; la segunda tuvo la herramienta rota durante meses.
  // Ahora que la lente busca el proxy sola, el usuario necesita ver DÓNDE
  // acabó preguntando para saber cuál de las dos tiene delante.
  const mock = await startMockOxideGate({ requests: [], stats: [] });

  try {
    const { stderr, code } = await runSavingsCli({ baseUrl: mock.url });

    assert.equal(code, 1);
    assert.match(stderr, /no ha visto|not seen/i);
    assert.ok(stderr.includes(mock.url), `debe nombrar el endpoint consultado; stderr fue: ${stderr}`);
  } finally {
    await mock.close();
  }
});

test('puerto ocupado por otro servicio -> "no es OxideGate", no un error de parseo JSON', async () => {
  // El 8080 es un puerto disputadísimo. Un usuario con cualquier otro servicio
  // web ahí recibía "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON":
  // un error de sintaxis que no nombra la causa ni dice qué hacer.
  const intruso = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
    res.end('<!DOCTYPE html><html><body>no soy OxideGate</body></html>');
  });
  await new Promise((r) => intruso.listen(0, '127.0.0.1', r));
  const port = intruso.address().port;

  try {
    const { stderr, code } = await runSavingsCli({ baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(code, 1, 'debe salir con error');
    assert.match(stderr, /no es OxideGate/, 'debe nombrar la causa real');
    assert.match(stderr, /OXIDEGATE_PORT/, 'debe decirle al usuario qué hacer');
    assert.doesNotMatch(stderr, /Unexpected token/, 'nunca un error de parseo crudo');
  } finally {
    intruso.close();
  }
});

// =======================================================================
// (d) VALVE INFORMADO MCP — precio (mcp-savings) + uso observado
// (OxideGate), por servidor. Ver lib/mcp-snapshot.mjs, lib/mcp-usage.mjs y
// lib/mcp-valve.mjs para el contrato completo (join, joinHealth, la
// conjunción de recomendación). Estos tests son de nivel CLI: cubren la
// matriz de degradación de 5 filas de design.md (OxideGate presente/ausente
// × snapshot fresco/stale/faltante) contra el binario real, y las cuatro
// disciplinas de honestidad que este bloque no puede violar sin fallar:
//
//   A. una fila "unknown" (gasto sin atribuir) es CONSPICUA — bloque propio.
//   B. toda recomendación de "0 usos" lleva su ventana en la MISMA línea.
//   C. un snapshot stale marca CADA precio/recomendación que muestra.
//   D. una medición ausente (`ok:false`) nunca se imprime como 0.
// =======================================================================

const nativeFiller = { server: '(native)', kind: 'native', tools: 1, bytes: 1 };

/**
 * Builds a `requests` array (oldest-first, RFC 3339 timestamps), evenly
 * spaced across `spanMs`, each carrying a `(native)` filler row (so
 * `newestBreakdown()` always has a usable, non-empty entry — see
 * bin/oxidegate-savings.mjs) plus whatever `mcpRows` the test wants. The
 * native filler never counts toward `lib/mcp-usage.mjs`'s `usesByLabel`
 * (only `kind: 'mcp'` rows do), so it never contaminates a usage count.
 */
function requestsWindow({ count, spanMs, mcpRows = [] }) {
  const now = Date.now();
  const start = now - spanMs;
  const step = count > 1 ? spanMs / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) =>
    baseEntry({
      timestamp: new Date(start + step * i).toISOString(),
      tools_by_server: [nativeFiller, ...mcpRows],
    }),
  );
}

test('valve informado (d) fila 1/5: OxideGate presente + snapshot fresco -> valve completo (precio + uso + recomendación)', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [
      { server: 'used_server', enabled: true, tokens: 100, bytes: 500, ok: true },
      { server: 'unused_server', enabled: true, tokens: 200, bytes: 700, ok: true },
    ],
  });
  const requests = requestsWindow({
    count: 5,
    spanMs: 45 * 60 * 1000,
    mcpRows: [{ server: 'used_server', kind: 'mcp', tools: 1, bytes: 50 }],
  });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('used_server'));
  assert.ok(stdout.includes('unused_server'));
  assert.ok(stdout.includes('usos observados: 5'), `used_server debe mostrar 5 usos: ${stdout}`);
  assert.ok(stdout.includes('candidato a desconectar'), `unused_server debe ser candidato: ${stdout}`);
  assertNoUnwindowedRecommendation(assert, stdout);
  assertNoFabricatedZero(assert, stdout);
  assertNoDroppedSpend(assert, stdout, ['used_server']);
  assertNoDeadCausalArtifacts(assert, stdout);
});

test('valve informado (d) fila 2/5: snapshot DESACTUALIZADO -> precio y recomendación marcados como stale en la MISMA línea', async () => {
  const claude = await knownZeroClaude();
  const staleTimestamp = Date.now() - 30 * 60 * 60 * 1000; // 30h > el umbral de 24h
  const snap = await makeFakeSnapshot({
    timestamp: staleTimestamp,
    mcpMeasurement: [{ server: 'unused_server', enabled: true, tokens: 200, bytes: 700, ok: true }],
  });
  const requests = requestsWindow({ count: 5, spanMs: 45 * 60 * 1000, mcpRows: [] });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  const isoStamp = new Date(staleTimestamp).toISOString();
  assert.ok(stdout.includes(isoStamp), `debe citar el timestamp original del snapshot: ${stdout}`);
  assert.ok(stdout.includes('DESACTUALIZADO'));

  const lines = stdout.split('\n');
  const serverLine = lines.find((l) => l.includes('unused_server') && l.includes('precio='));
  assert.ok(serverLine, 'debe haber una fila para unused_server');
  assert.ok(
    serverLine.includes('DESACTUALIZADO'),
    `el precio mostrado debe marcarse stale en la MISMA línea: ${serverLine}`,
  );

  const candidateLines = lines.filter((l) => l.includes('candidato a desconectar'));
  assert.ok(candidateLines.length > 0, 'este fixture debe producir al menos una recomendación candidata');
  for (const line of candidateLines) {
    assert.ok(
      line.includes('DESACTUALIZADO'),
      `una recomendación basada en un snapshot stale DEBE marcarlo en la MISMA línea: ${line}`,
    );
  }
  assertNoUnwindowedRecommendation(assert, stdout);
});

test('valve informado (d) fila 3/5: OxideGate presente + snapshot faltante/malformado -> sólo filas "unknown", pista de instalación, nunca precio inventado', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({ malformed: true });
  const requests = requestsWindow({
    count: 5,
    spanMs: 45 * 60 * 1000,
    mcpRows: [{ server: 'mystery_server', kind: 'mcp', tools: 1, bytes: 30 }],
  });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('el snapshot tiene JSON inválido'), `debe nombrar la razón real: ${stdout}`);
  assert.ok(stdout.includes('GASTO SIN ATRIBUIR'));
  assert.ok(stdout.includes('mystery_server'));
  assertNoDroppedSpend(assert, stdout, ['mystery_server']);
  assertNoFabricatedZero(assert, stdout);
  assertNoDeadCausalArtifacts(assert, stdout);
});

test('valve informado (d) fila 4/5: observación insuficiente + snapshot fresco -> precio se muestra, SIN recomendación (razón nombrada)', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [{ server: 'quiet_server', enabled: true, tokens: 50, bytes: 400, ok: true }],
  });
  // Sólo 2 peticiones en 5 minutos: falla AMBOS gates de suficiencia
  // (ventana >= 30min Y conteo >= 5) — ver lib/mcp-usage.mjs.
  const requests = requestsWindow({ count: 2, spanMs: 5 * 60 * 1000, mcpRows: [] });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('quiet_server'));
  assert.ok(stdout.includes('400 B'));
  assert.ok(
    !stdout.includes('candidato a desconectar'),
    'sin observación suficiente no debe recomendar nada, ni siquiera un "0 usos" real',
  );
  assert.ok(
    stdout.includes('todavía no hay suficiente observación para juzgar uso') ||
      stdout.includes('observación insuficiente'),
    `debe nombrar la razón de la ausencia de recomendación: ${stdout}`,
  );
  assertNoUnwindowedRecommendation(assert, stdout);
  assertNoFabricatedZero(assert, stdout);
});

test('valve informado (d) fila 5/5: sin snapshot y sin observación suficiente -> cero filas, un aviso, nunca un crash', async () => {
  const claude = await knownZeroClaude();
  const requests = requestsWindow({ count: 1, spanMs: 0, mcpRows: [] });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({ baseUrl: mock.url, claudePath: claude.path });
  await mock.close();
  await claude.cleanup();

  assert.equal(code, 0);
  assert.ok(stdout.includes('no hay datos de valve'), `debe decir explícitamente que no hay datos: ${stdout}`);
  assertNoDeadCausalArtifacts(assert, stdout);
});

test('valve informado (d): el gasto "unknown" es CONSPICUO — bloque propio, nunca confundido con la tabla por-servidor', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [{ server: 'known_server', enabled: true, tokens: 10, bytes: 100, ok: true }],
  });
  const requests = requestsWindow({
    count: 5,
    spanMs: 45 * 60 * 1000,
    mcpRows: [
      { server: 'known_server', kind: 'mcp', tools: 1, bytes: 20 },
      { server: 'ghost_server', kind: 'mcp', tools: 1, bytes: 15 },
    ],
  });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  const lines = stdout.split('\n');
  // ghost_server is a REAL `kind: 'mcp'` row on the wire, so it legitimately
  // also appears in section (a)'s byte table (which lists every wire row,
  // unrelated to the snapshot join). Only section (d) — the informed
  // valve — is under test here, so every index below is scoped to AFTER
  // that section's own header, never the whole stdout.
  const sectionDStartIdx = lines.findIndex((l) => l.includes('valve informado MCP'));
  assert.ok(sectionDStartIdx > -1, 'debe existir la sección (d)');

  const unknownHeaderIdx = lines.findIndex((l, i) => i > sectionDStartIdx && l.includes('GASTO SIN ATRIBUIR'));
  assert.ok(unknownHeaderIdx > -1, 'debe existir un bloque propio para gasto sin atribuir');

  const ghostLineIdx = lines.findIndex((l, i) => i > sectionDStartIdx && l.includes('ghost_server'));
  assert.ok(
    ghostLineIdx > unknownHeaderIdx,
    'ghost_server (sin entrada de snapshot), DENTRO de la sección (d), debe estar DENTRO del bloque "unknown", no antes',
  );

  const knownServerLine = lines.find((l, i) => i > sectionDStartIdx && l.includes('known_server') && l.includes('['));
  assert.ok(knownServerLine, 'known_server (con snapshot) debe seguir en la tabla por-servidor normal');
  const knownServerIdx = lines.indexOf(knownServerLine);
  assert.ok(
    knownServerIdx < unknownHeaderIdx,
    'la fila con snapshot debe estar ANTES del bloque "unknown", nunca mezclada dentro de él',
  );
  assertNoDroppedSpend(assert, stdout, ['ghost_server', 'known_server']);
});

test('valve informado (d): precio "no se pudo medir" (ok:false, bytes:0) nunca se imprime como 0 B — ausencia no es cero', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [{ server: 'broken_server', enabled: true, tokens: null, bytes: 0, ok: false }],
  });
  const requests = requestsWindow({
    count: 5,
    spanMs: 45 * 60 * 1000,
    mcpRows: [{ server: 'broken_server', kind: 'mcp', tools: 1, bytes: 5 }],
  });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  const line = stdout.split('\n').find((l) => l.includes('broken_server') && l.includes('precio='));
  assert.ok(line, 'debe haber una fila para broken_server');
  assert.ok(line.includes('no se pudo medir'), `precio ok:false debe decir "no se pudo medir": ${line}`);
  assert.ok(!line.includes('0 B'), `precio ok:false NUNCA debe imprimirse como 0 B: ${line}`);
  assertNoFabricatedZero(assert, stdout);
});

// =======================================================================
// name-collision a nivel CLI. La rama estaba cubierta en
// test/mcp-valve.test.mjs (unidad), pero nunca se había atravesado el
// binario real: un `join: 'ambiguous'` que la unidad calcula bien todavía
// puede renderizarse como una recomendación en la sección (d) si el
// formateador lo trata como una fila cualquiera. Este test lee el stdout
// REAL, que es el único sitio donde ese fallo se vería.
//
// `sanitizeServerName` es `name.replace(/[^A-Za-z0-9_]/g, '_')` (verificado
// en lib/mcp-config.mjs:165-167), así que `pago-api` y `pago.api` colapsan
// AMBOS en `pago_api`. El cable gasta en `pago_api` y no hay forma honesta
// de saber a cuál de los dos atribuirlo.
// =======================================================================
test('valve informado (d): dos nombres de snapshot que colisionan al sanear -> ambos AMBIGUOS en stdout, ninguno recomendado, el uso jamás atribuido', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [
      { server: 'pago-api', enabled: true, tokens: 100, bytes: 500, ok: true },
      { server: 'pago.api', enabled: true, tokens: 200, bytes: 900, ok: true },
      // Un tercero que SÍ casa limpio: sin él, la única correspondencia del
      // fixture sería la colisión, y no podríamos distinguir "se calló por
      // la colisión" de "se calló porque no hay correspondencia ninguna".
      { server: 'limpio_server', enabled: true, tokens: 10, bytes: 100, ok: true },
    ],
  });
  const requests = requestsWindow({
    count: 5,
    spanMs: 45 * 60 * 1000,
    mcpRows: [
      { server: 'pago_api', kind: 'mcp', tools: 2, bytes: 40 },
      { server: 'limpio_server', kind: 'mcp', tools: 1, bytes: 20 },
    ],
  });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);

  const lines = stdout.split('\n');
  const sectionD = lines.slice(lines.findIndex((l) => l.includes('valve informado MCP')));
  assert.ok(sectionD.length > 0, 'debe existir la sección (d)');

  // 1. Los DOS nombres crudos sobreviven. Elegir uno sería inventarse a cuál
  //    pertenece el gasto; borrar el otro sería ocultar que existe.
  for (const raw of ['pago-api', 'pago.api']) {
    const row = sectionD.find((l) => l.includes(raw));
    assert.ok(row, `el nombre crudo "${raw}" debe aparecer en la sección (d), no colapsado en el saneado`);
    assert.ok(row.includes('[ambiguo]'), `"${raw}" debe marcarse como ambiguo: ${row}`);
    assert.ok(
      !/\busos observados:\s*\d/.test(row),
      `"${raw}" no puede reclamar uso del cable: el gasto de pago_api no es atribuible a ninguno de los dos: ${row}`,
    );
  }

  // 2. Ninguno de los dos puede acabar recomendado, en ninguna dirección.
  //    Este es el fallo caro: una colisión tratada como fila normal daría
  //    "candidato a desconectar" sobre un servidor que quizá está en uso.
  const ambiguousBlock = sectionD.filter(
    (l) => l.includes('pago-api') || l.includes('pago.api') || l.includes('nombre ambiguo'),
  );
  for (const line of ambiguousBlock) {
    assert.ok(
      !line.includes('candidato a desconectar'),
      `una fila ambigua nunca puede recomendarse para desconectar: ${line}`,
    );
  }

  // 3. La razón nombrada llega al usuario. Sin esto, el lector ve "sin
  //    recomendación" y no sabe si es que falta observación o que el nombre
  //    es irresoluble — dos problemas con acciones distintas.
  const collisionReason = sectionD.filter((l) => l.includes('nombre ambiguo'));
  assert.equal(
    collisionReason.length,
    2,
    'cada fila ambigua debe llevar su propia razón de colisión, no una nota compartida al pie',
  );

  // 4. El servidor que casa limpio NO queda contaminado por la colisión
  //    ajena: sigue siendo juzgable.
  const limpio = sectionD.find((l) => l.includes('limpio_server') && l.includes('precio='));
  assert.ok(limpio, 'el servidor sin colisión debe seguir renderizando su fila');
  assert.ok(!limpio.includes('[ambiguo]'), `una colisión ajena no debe marcar a limpio_server: ${limpio}`);

  assertNoDeadCausalArtifacts(assert, stdout);
  assertNoUnwindowedRecommendation(assert, stdout);
  assertNoFabricatedZero(assert, stdout);
  assertNoDroppedSpend(assert, stdout, ['pago_api', 'limpio_server']);
});

// =======================================================================
// tools_flattened, a nivel CLI.
//
// Encontrado corriendo contra un proxy vivo: OpenCode en /v1/responses manda
// las 40 tools en un solo bloque `(native)` con `tools_flattened: true`. Las
// MCP están ahí dentro; nada dice cuál es cuál.
//
// El defecto que este test fija NO es que faltara la razón — es que al
// añadirla, el PIE de la sección seguía diciendo "todavía no alcanza para
// juzgar uso" debajo de unas filas que acababan de explicar que esperar no
// sirve. Dos frases contradictorias en la misma pantalla, y el lector se
// queda con la que le hace perder el tiempo. Esa contradicción se vio
// leyendo el stdout real, que es justo para lo que existe esta suite.
// =======================================================================
test('valve informado (d): tools aplanadas -> razón permanente, y el pie NO contradice diciendo "todavía no alcanza"', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [{ server: 'engram', enabled: true, tokens: 3788, bytes: 17233, ok: true }],
  });
  const requests = requestsWindow({
    count: 6,
    spanMs: 45 * 60 * 1000,
    mcpRows: [{ server: '(native)', kind: 'native', tools: 40, bytes: 48131 }],
  });
  // Lo que hace la ruta /v1/responses de verdad.
  requests.forEach((r) => {
    r.tools_flattened = true;
  });
  const mock = await startMockOxideGate({ requests, stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0);
  const sectionD = stdout.slice(stdout.indexOf('valve informado MCP'));

  assert.ok(sectionD.includes('tools_flattened'), 'la razón real debe nombrarse, no esconderse tras una genérica');
  assert.ok(
    /esperar más NO lo cambia|Más tráfico no lo cambia/.test(sectionD),
    'el usuario debe saber que esperar no sirve: es la única diferencia útil con observación insuficiente',
  );
  assert.ok(
    !sectionD.includes('todavía no alcanza para juzgar uso'),
    'el pie no puede decir "todavía no alcanza" bajo filas que explican que esperar es inútil — es la contradicción que este test fija',
  );
  assert.ok(!/\b0 usos\b/.test(sectionD), 'con las tools aplanadas, un 0 sería fabricado');
  assert.ok(!sectionD.includes('candidato a desconectar'), 'jamás recomendar desconectar sin atribución');

  assertNoDeadCausalArtifacts(assert, stdout);
  assertNoUnwindowedRecommendation(assert, stdout);
  assertNoFabricatedZero(assert, stdout);
});

// =======================================================================
// --doctor a nivel CLI.
//
// Los dos defectos que tuvo eran de CABLEADO, no de lógica, y por eso
// ninguno de los once tests unitarios del módulo los vio:
//
//   1. `getJson` lanza a propósito y el manejador de arriba imprime y sale,
//      así que el doctor MORÍA antes de diagnosticar — precisamente en los
//      dos casos para los que existe. Un diagnóstico que se muere con el
//      paciente no sirve de nada.
//   2. Con un WordPress ocupando el puerto, /health devolvía 200 (redirige a
//      wp-admin/install.php) y el doctor afirmaba "el proxy está vivo y
//      sirviendo" DOS LÍNEAS DESPUÉS de haber descartado que ese servicio
//      fuera OxideGate.
//
// Los dos se vieron ejecutándolo. Este test los fija.
// =======================================================================
test('--doctor: con el proxy sano imprime el diagnóstico completo y sale con 0', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({
    mcpMeasurement: [{ server: 'engram', enabled: true, tokens: 100, bytes: 500, ok: true }],
  });
  const mock = await startMockOxideGate({ requests: requestsWindow({ count: 3, spanMs: 60_000 }), stats: [] });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
    args: ['--doctor'],
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 0, 'un proxy que responde no puede salir con código de error');
  assert.match(stdout, /diagnóstico de la cadena/);
  assert.match(stdout, /El proxy responde/);
  assert.match(stdout, /peticiones observadas/);
});

test('--doctor: contra un puerto muerto DIAGNOSTICA en vez de morir', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({ missing: true });

  // Puerto 9 (discard): cerrado en la práctica. Antes, `getJson` lanzaba y
  // el proceso salía con "fetch failed" sin llegar a diagnosticar nada.
  const { stdout } = await runSavingsCli({
    baseUrl: 'http://127.0.0.1:9',
    claudePath: claude.path,
    homePath: snap.homePath,
    args: ['--doctor'],
  });
  await claude.cleanup();
  await snap.cleanup();

  assert.match(stdout, /diagnóstico de la cadena/, 'debe llegar a diagnosticar');
  assert.match(stdout, /Nada responde/);
  assert.doesNotMatch(stdout, /fetch failed/, 'el error crudo no puede sustituir al diagnóstico');
});

test('--help: responde sin tocar el proxy', async () => {
  const claude = await knownZeroClaude();
  const { stdout, code } = await runSavingsCli({
    baseUrl: 'http://127.0.0.1:9',
    claudePath: claude.path,
    args: ['--help'],
  });
  await claude.cleanup();

  assert.equal(code, 0, 'la ayuda no depende de que haya un proxy');
  assert.match(stdout, /oxidegate-savings/);
  assert.match(stdout, /--doctor/);
});

test('--doctor: un proxy anterior a 0.3.0 (sin /health) se declara ROTO, y dice por qué', async () => {
  const claude = await knownZeroClaude();
  const snap = await makeFakeSnapshot({ mcpMeasurement: [] });
  // health:false simula justo el binario que estuvo instalado meses: sirve
  // /requests pero no /health, así que el enrutado caía a directo en silencio.
  const mock = await startMockOxideGate({ requests: requestsWindow({ count: 3, spanMs: 60_000 }), stats: [], health: false });

  const { stdout, code } = await runSavingsCli({
    baseUrl: mock.url,
    claudePath: claude.path,
    homePath: snap.homePath,
    args: ['--doctor'],
  });
  await mock.close();
  await claude.cleanup();
  await snap.cleanup();

  assert.equal(code, 1, 'un eslabón roto tiene que notarse en el código de salida');
  assert.match(stdout, /health devuelve 404/i);
  assert.match(stdout, /SILENCIO/i, 'la consecuencia es lo que lo hacía indiagnosticable');
  assert.match(stdout, /BROKEN/);
});
