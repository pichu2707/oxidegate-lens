// test/mcp-config-editor.test.mjs
//
// Unit tests for lib/mcp-config-editor.mjs — the selector where a user picks
// which MCP servers start disconnected and which are never touched.
//
// The whole editor is pure: state in, state out, and a render that returns a
// STRING rather than writing to a terminal. That is what makes a TUI testable
// at all under this repo's `node --test` runner, and it follows the same
// Decision 1 discipline as the plugin — the binary is a shell around this.
//
// Two rules this file exists to pin:
//
//   1. An absent snapshot is NOT an empty server list. "You have no MCP
//      servers" and "I could not read which servers you have" are different
//      sentences, and only one of them is a fact.
//   2. Editing a protection list while the switch is OFF is editing something
//      that does nothing. The editor has to say so, not let the user tick
//      boxes into the void.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEditorState,
  moveCursor,
  toggleAtCursor,
  toggleDisableByDefault,
  toConfig,
  renderEditor,
} from '../lib/mcp-config-editor.mjs';

const snapshot = (servers) => ({
  status: 'known',
  freshness: 'fresh',
  timestamp: 1_700_000_000_000,
  servers,
});
const server = (name, bytes) => ({ name, enabled: true, tokens: 0, price: { status: 'known', bytes } });

const baseState = () =>
  buildEditorState({
    snapshot: snapshot([server('engram', 17233), server('context7', 4577)]),
    protection: { status: 'known', servers: ['engram'], source: 'file' },
    switchResult: { status: 'known', enabled: true, source: 'file' },
  });

test('builds one row per snapshot server, marking which are protected', () => {
  const state = baseState();

  assert.equal(state.status, 'ready');
  assert.deepEqual(
    state.rows.map((r) => [r.name, r.protected]),
    [
      ['engram', true],
      ['context7', false],
    ],
  );
  assert.equal(state.disableByDefault, true);
  assert.equal(state.cursor, 0);
});

test('an absent snapshot is NOT an empty list of servers', () => {
  const state = buildEditorState({
    snapshot: { status: 'unknown', reason: 'missing-file' },
    protection: { status: 'known', servers: [], source: 'default' },
    switchResult: { status: 'known', enabled: false, source: 'default' },
  });

  // Rendering an empty selector here would tell the user they have no MCP
  // servers, which is a claim. We only know we could not read the snapshot.
  assert.equal(state.status, 'no-inventory');
  assert.equal(state.reason, 'missing-file');
  assert.equal(state.rows, undefined, 'there must be no empty list for a caller to render as "none"');
});

test('a protected name the snapshot does not know still gets a row — it is what a typo looks like', () => {
  const state = buildEditorState({
    snapshot: snapshot([server('engram', 17233)]),
    protection: { status: 'known', servers: ['engram', 'fantasma'], source: 'file' },
    switchResult: { status: 'known', enabled: true, source: 'file' },
  });

  const ghost = state.rows.find((r) => r.name === 'fantasma');
  assert.ok(ghost, 'un nombre protegido que no aparece en el snapshot no puede desaparecer de la pantalla');
  assert.equal(ghost.protected, true);
  assert.equal(ghost.price, undefined, 'no lo midió nadie: no hay precio que enseñar');
  assert.equal(ghost.knownToSnapshot, false);
});

test('the cursor moves and clamps at both ends', () => {
  let state = baseState();
  assert.equal(moveCursor(state, -1).cursor, 0, 'no envuelve por arriba');
  state = moveCursor(state, 1);
  assert.equal(state.cursor, 1);
  assert.equal(moveCursor(state, 1).cursor, 1, 'no envuelve por abajo');
});

test('toggling flips only the row under the cursor', () => {
  const state = toggleAtCursor(baseState());

  assert.deepEqual(
    state.rows.map((r) => r.protected),
    [false, false],
    'engram deja de estar protegido y context7 no se toca',
  );
});

test('toConfig emits exactly the two keys the config file owns', () => {
  const state = toggleAtCursor(moveCursor(baseState(), 1)); // protege context7 también
  const config = toConfig(state);

  assert.deepEqual(Object.keys(config).sort(), ['disableByDefault', 'protectedMcpServers']);
  assert.equal(config.disableByDefault, true);
  assert.deepEqual(config.protectedMcpServers.sort(), ['context7', 'engram']);
});

test('toConfig round-trips through readProtectedServers without drift', async () => {
  const { readProtectedServers } = await import('../lib/mcp-protection.mjs');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'editor-roundtrip-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(toConfig(baseState()), null, 2));
  const read = readProtectedServers({ path, env: {} });
  await rm(dir, { recursive: true, force: true });

  // El editor y el lector tienen que hablar el mismo idioma. Si divergen, el
  // usuario marca casillas que el plugin luego no obedece.
  assert.equal(read.status, 'known');
  assert.deepEqual(read.servers, ['engram']);
});

test('the switch can be toggled, and it is what toConfig writes', () => {
  const state = toggleDisableByDefault(baseState());
  assert.equal(state.disableByDefault, false);
  assert.equal(toConfig(state).disableByDefault, false);
});

test('render shows each server with its price and its mark', () => {
  const out = renderEditor(baseState());

  assert.match(out, /engram/);
  assert.match(out, /17\.2 kB/);
  assert.match(out, /context7/);
  assert.match(out, /4\.6 kB/);
});

test('render WARNS when the list is being edited while the switch is off', () => {
  const out = renderEditor(toggleDisableByDefault(baseState()));

  // Marcar protegidos con el interruptor apagado no protege de nada: no se
  // desconecta nadie. Dejar al usuario rellenar esa lista sin decírselo es
  // dejarle configurar el vacío.
  //
  // Se asserta la INTENCIÓN, no la redacción: que diga que está apagada, y
  // que las marcas no sirven de nada mientras lo esté. La versión anterior
  // fijaba la frase literal y se rompió al reescribir el selector, sin que
  // la garantía hubiera dejado de cumplirse ni un momento.
  assert.match(out, /apagada|desactivad|no se apaga ninguno/i, 'debe decir que está apagada');
  assert.match(out, /marcas no hacen nada|no cambian nada/i, 'y que marcar no sirve de nada así');
});

test('render never invents a price for a server nobody measured', () => {
  const state = buildEditorState({
    snapshot: snapshot([server('engram', 17233)]),
    protection: { status: 'known', servers: ['engram', 'fantasma'], source: 'file' },
    switchResult: { status: 'known', enabled: true, source: 'file' },
  });

  const line = renderEditor(state).split('\n').find((l) => l.includes('fantasma'));
  assert.ok(line);
  assert.doesNotMatch(line, /\b0(\.0)? ?[kMB]?B\b/, 'sin medición no hay cifra, ni siquiera un cero');
});

test('render of a no-inventory state explains instead of showing an empty table', () => {
  const out = renderEditor({ status: 'no-inventory', reason: 'missing-file' });

  assert.doesNotMatch(out, /^\s*$/, 'algo tiene que decir');
  assert.match(out, /mcp-savings/, 'debe apuntar a la herramienta que produce el inventario');
});

// =======================================================================
// mergeIntoConfig — lo que se escribe en disco.
//
// Estaba dentro de bin/oxidegate-mcp.mjs, que es exactamente lo que la
// cabecera de ese fichero prohíbe: lógica en la cáscara, fuera del alcance
// de `node --test`. Fusionar mal destruye configuración que el usuario
// escribió y que este selector ni siquiera muestra, así que no puede vivir
// donde nada lo comprueba.
// =======================================================================

test('mergeIntoConfig conserva claves ajenas que el selector ni muestra', async () => {
  const { mergeIntoConfig } = await import('../lib/mcp-config-editor.mjs');

  const merged = mergeIntoConfig({ algoDelUsuario: 42, disableByDefault: false }, baseState());

  assert.equal(merged.algoDelUsuario, 42, 'lo que no es nuestro no se toca');
  assert.equal(merged.disableByDefault, true, 'lo que sí es nuestro se sobrescribe con lo elegido');
  assert.deepEqual(merged.protectedMcpServers, ['engram']);
});

test('mergeIntoConfig parte de cero cuando lo previo no es un objeto usable', async () => {
  const { mergeIntoConfig } = await import('../lib/mcp-config-editor.mjs');

  for (const basura of [null, undefined, [], 'texto', 42]) {
    const merged = mergeIntoConfig(basura, baseState());
    // Un fichero ilegible no tiene claves rescatables. Intentar adivinarlas
    // sería peor que empezar limpio con lo que el usuario acaba de elegir.
    assert.deepEqual(Object.keys(merged).sort(), ['disableByDefault', 'protectedMcpServers'], `con ${JSON.stringify(basura)}`);
  }
});

test('mergeIntoConfig no muta el objeto que recibe', async () => {
  const { mergeIntoConfig } = await import('../lib/mcp-config-editor.mjs');

  const previo = { disableByDefault: false, protectedMcpServers: ['viejo'] };
  mergeIntoConfig(previo, baseState());

  assert.deepEqual(previo, { disableByDefault: false, protectedMcpServers: ['viejo'] }, 'la fuente queda intacta');
});

// =======================================================================
// Guardarraíl estático del binario.
//
// bin/oxidegate-mcp.mjs es una CÁSCARA por decisión explícita: una TUI no se
// puede ejecutar bajo `node --test`, así que todo lo decidible vive en este
// módulo. Eso solo vale algo si algo se entera cuando la lógica empieza a
// filtrarse de vuelta — ya pasó una vez con la fusión del config, que nació
// dentro del binario y hubo que mover.
// =======================================================================

test('el binario delega en lib/ en vez de reimplementar', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../bin/oxidegate-mcp.mjs'), 'utf8');

  for (const fn of ['buildEditorState', 'moveCursor', 'toggleAtCursor', 'toggleDisableByDefault', 'mergeIntoConfig', 'renderEditor']) {
    assert.ok(src.includes(fn), `el binario debe llamar a ${fn}, no reescribirlo`);
  }
  assert.ok(!/\.filter\(\(row\) => row\.protected\)/.test(src), 'construir la lista de protegidos es de toConfig, no del binario');
});

test('el binario sobrevive a que le corten stdout y a no tener TTY', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../bin/oxidegate-mcp.mjs'), 'utf8');

  // Pipear a `head` cerró stdout y Node lanzó EPIPE con veinte líneas de
  // stack. Pipear es uso normal, no un error del usuario.
  assert.ok(/EPIPE/.test(src), 'debe manejar EPIPE: `| head` es uso normal de un CLI');
  // Y sin TTY tiene que imprimir lo que sabe, no morir como hacía
  // oxidegate-monitor con "No such device or address".
  assert.ok(/isTTY/.test(src), 'debe degradar sin TTY en vez de abrir una TUI imposible');
  assert.ok(/--help/.test(src), 'todo binario tiene que saber describirse');
});

// =======================================================================
// El pie: quién aplica esto.
//
// El selector decía dónde se guarda la configuración y NUNCA quién la lee.
// En pi o en Codex CLI eso significa marcar servidores, ver "Configuración
// en: ...", y creer que has configurado algo — cuando el único consumidor de
// ese fichero es el plugin de OpenCode. Guardar bien y no aplicar nada, en
// silencio, es el peor de los fallos posibles aquí: no hay error que buscar.
//
// Va DENTRO de renderEditor a propósito, no como función aparte. Estaba solo
// en printOnce, así que el modo interactivo —el camino principal— no lo
// enseñaba. Metiéndolo en el render es imposible pintar el selector sin él.
// =======================================================================

test('el render dice DÓNDE se guarda y QUIÉN lo aplica', () => {
  const out = renderEditor(baseState(), { configPath: '/casa/.config/oxidegate-lens/config.json' });

  assert.match(out, /\/casa\/\.config\/oxidegate-lens\/config\.json/, 'la ruta debe salir');
  assert.match(out, /OpenCode/, 'y quién la aplica, que es la parte que faltaba');
});

test('el render avisa de que en otros harnesses no lo lee nadie', () => {
  const out = renderEditor(baseState(), { configPath: '/x/config.json' });

  // Sin esto, un usuario de pi configura el vacío y no tiene forma de saberlo.
  assert.match(out, /pi\b/, 'debe nombrar el harness donde esto no aplica');
  assert.match(out, /no lo lee nadie|no lo aplica nadie|NADIE/i);
});

test('sin ruta, el pie no imprime una ruta rota', () => {
  const out = renderEditor(baseState());

  assert.doesNotMatch(out, /undefined/, 'jamás una ruta undefined en pantalla');
  assert.doesNotMatch(out, /Configuración en:\s*$/m, 'ni una etiqueta con el hueco vacío detrás');
});

test('el estado sin inventario no arrastra el pie: no hay nada configurado que aplicar', () => {
  const out = renderEditor({ status: 'no-inventory', reason: 'missing-file' }, { configPath: '/x/config.json' });

  assert.doesNotMatch(out, /OpenCode/, 'ahí el mensaje útil es instalar mcp-savings, no quién aplicaría una lista que no existe');
});

test('el binario no vuelve a construir el pie por su cuenta', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../bin/oxidegate-mcp.mjs'), 'utf8');

  // Tercera fuga de lógica a la cáscara en este mismo fichero (antes: la
  // fusión del config, y este pie). El patrón está claro, así que el
  // guardarraíl se queda.
  assert.ok(!/Configuración en:/.test(src), 'la ruta la compone renderEditor, no el binario');
  assert.ok(!/Lo aplica:/.test(src), 'y quién lo aplica también');
  const renders = src.match(/renderEditor\(state, \{ configPath:/g) ?? [];
  assert.equal(renders.length, 2, 'los DOS caminos —imprimir y TUI— deben pasar la ruta, o uno se queda mudo');
});

// =======================================================================
// LEGIBILIDAD DEL SELECTOR (issue #25)
//
// Un usuario real quería apagar context7 y acabó con la válvula entera
// apagada y los dos servidores arrancando conectados. No fue torpeza: el
// selector no dice en ninguna parte qué teclas existen, así que se
// descubren pulsando — y una de ellas apaga la función entera.
//
// Y la fila seguía afirmando "se desconecta al arrancar" con el
// interruptor apagado. El pie lo desmentía tres líneas más abajo, pero la
// fila se lee primero: un dato falso corregido después sigue siendo falso.
// =======================================================================

test('el render SIEMPRE enseña las teclas: no se descubren pulsando', () => {
  const out = renderEditor(baseState());

  assert.match(out, /espacio/i, 'la tecla que marca');
  assert.match(out, /\bd\b/, 'la que alterna la válvula — la que apagó a un usuario sin querer');
  assert.match(out, /enter/i, 'la que guarda');
  assert.match(out, /\bq\b/i, 'la que sale');
});

test('con la válvula APAGADA, ninguna fila puede decir que algo se desconecta', () => {
  const out = renderEditor(toggleDisableByDefault(baseState()));

  const filas = out.split('\n').filter((l) => l.includes('context7') || l.includes('engram'));
  assert.ok(filas.length >= 2, 'las filas siguen estando');
  for (const fila of filas) {
    assert.doesNotMatch(
      fila,
      /se desconecta|se apaga/i,
      `la fila afirma algo que no va a pasar: ${fila}`,
    );
  }
});

test('con la válvula ENCENDIDA la fila no marcada sí dice que se apaga', () => {
  const out = renderEditor(baseState());
  const fila = out.split('\n').find((l) => l.includes('context7'));

  assert.match(fila, /se apaga|se desconecta/i, 'sin esto la fila no dice qué le va a pasar');
});

test('el render suma lo que ahorras: el dato ya estaba y no se sumaba en ningún sitio', () => {
  const out = renderEditor(baseState());

  // context7 (4.6 kB) no está protegido, engram (17.2 kB) sí. Se ahorra el primero.
  assert.match(out, /4\.6 kB/, 'el total del ahorro debe aparecer');
  assert.match(out, /ahorr/i, 'y decir que es un ahorro, no un número suelto');
});

test('con la válvula apagada no se anuncia ningún ahorro, porque no lo hay', () => {
  const out = renderEditor(toggleDisableByDefault(baseState()));

  assert.doesNotMatch(out, /ahorras \d/i, 'prometer un ahorro que no va a ocurrir es peor que no decir nada');
});

// =======================================================================
// LA PORTADA
//
// El selector es lo primero que abre alguien que quiere configurar esto, y
// no decía ni cómo se llama ni quién lo hizo. Una herramienta sin nombre
// en su propia pantalla de configuración parece un script prestado.
// =======================================================================

test('la portada dice el nombre del producto y quién lo firma', () => {
  const out = renderEditor(baseState());

  assert.match(out, /OXIDEGATE|OxideGate/i, 'el nombre');
  assert.match(out, /JaviLazaro/, 'y la firma');
});

test('la portada enseña la versión cuando se le da', () => {
  const out = renderEditor(baseState(), { version: '0.7.0' });

  assert.match(out, /0\.7\.0/);
});

test('sin versión no imprime un hueco ni un undefined', () => {
  // Misma disciplina que con configPath: una etiqueta con la nada detrás es
  // peor que no poner la etiqueta.
  const out = renderEditor(baseState());

  assert.doesNotMatch(out, /undefined/, 'jamás un undefined en pantalla');
  assert.doesNotMatch(out, /\bv\s*$/m, 'ni una v suelta esperando un número');
});

test('la portada también sale cuando no hay inventario que mostrar', () => {
  // Es justo cuando más falta hace saber qué herramienta te está hablando:
  // la pantalla de error es la que más gente ve sin contexto.
  const out = renderEditor({ status: 'no-inventory', reason: 'missing-file' });

  assert.match(out, /OXIDEGATE|OxideGate/i);
});

test('la caja de la portada CUADRA: todos sus bordes en la misma columna', () => {
  // Se comprueba en vez de mirarla: un ancho calculado a mano se descuadra
  // en cuanto alguien cambia el título, la versión o la firma, y nadie se
  // entera hasta que sale feo en la pantalla de otro. La primera versión de
  // esta portada ya salió torcida por contar mal seis caracteres.
  for (const version of [undefined, '0.7.0', '1.10.12']) {
    const lineas = renderEditor(baseState(), { version })
      .split('\n')
      .filter((l) => /[╭│╰]/.test(l));

    assert.ok(lineas.length >= 4, 'la portada tiene sus cuatro líneas');
    const anchos = new Set(lineas.map((l) => [...l].length));
    assert.equal(anchos.size, 1, `con version=${version} los bordes no cuadran: ${[...anchos].join(', ')}`);
  }
});
