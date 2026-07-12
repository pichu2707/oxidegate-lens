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
import { runSavingsCli, assertNoDeadCausalArtifacts } from './helpers/run-savings-cli.mjs';

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
  // legítimamente. Todo lo demás — tabla, veredictos, texto de ausencia —
  // tiene que ser byte-por-byte idéntico: el header `client` nunca decide.
  const [, ...rest1] = run1.stdout.split('\n');
  const [, ...rest2] = run2.stdout.split('\n');
  assert.equal(rest1.join('\n'), rest2.join('\n'));

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
// Protección adicional (no un defecto pasado, uno esperando pasar): el
// camino "harness eager" (upstream !== 'anthropic') tiene que seguir
// diciendo el ahorro DIRECTO y sin cobertura de duda — nueve rondas de
// hedging hacen que sobre-corregir sea el próximo fallo más probable.
// =======================================================================

test('camino eager (upstream != anthropic): el ahorro se imprime SIN lenguaje de incertidumbre', async () => {
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
      'Este dialecto (openai) no tiene primitivo de diferido: no existe una versión\n' +
        'donde estos bytes sean opcionales, para ningún harness. El costo de arriba es real,\n' +
        'sin ambigüedad — nada que decidir aquí.',
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
