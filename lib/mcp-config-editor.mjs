// lib/mcp-config-editor.mjs
//
// CONTRACT
// --------
// The selector where a user picks which MCP servers start disconnected and
// which are never touched. Entirely PURE: state in, state out, and a render
// that RETURNS A STRING rather than writing to a terminal.
//
// Exports:
//   buildEditorState({ snapshot, protection, switchResult }) -> EditorState
//   moveCursor(state, delta)            -> EditorState
//   toggleAtCursor(state)               -> EditorState
//   toggleDisableByDefault(state)       -> EditorState
//   toConfig(state)                     -> { disableByDefault, protectedMcpServers }
//   renderEditor(state)                 -> string
//
// EditorState is one of:
//   { status: 'ready', disableByDefault, rows: Row[], cursor }
//   { status: 'no-inventory', reason }
//
// Row: { name, price: {status,bytes}|undefined, protected: boolean,
//        knownToSnapshot: boolean }
//
// WHY THE PURITY IS NOT DECORATION
// ----------------------------------
// A TUI is the least testable thing a repo can own: raw keyboard modes,
// escape codes, a terminal that only exists when a human is watching. This
// repo's runner is `node --test` over `.mjs` and cannot drive any of that.
// So the same split as the OpenCode plugin (design.md Decision 1) applies:
// every decision — what rows exist, what a keypress does, what text comes
// out — lives HERE and is asserted, and `bin/oxidegate-mcp.mjs` is a shell
// that reads keys and prints strings. If logic starts leaking into the
// binary, it stops being covered by anything.
//
// AN ABSENT SNAPSHOT IS NOT AN EMPTY LIST OF SERVERS
// ----------------------------------------------------
// The inventory comes from the `mcp-savings` snapshot, the only source that
// knows server names AND their price without depending on which harness is
// running. When it cannot be read, this returns `status: 'no-inventory'` and
// carries NO `rows` array — the same shape discipline as
// `lib/mcp-protection.mjs`. Rendering an empty selector would tell the user
// "you have no MCP servers", which is a claim; all we know is that we could
// not read the file.
//
// A PROTECTED NAME THE SNAPSHOT DOES NOT KNOW STILL GETS A ROW
// --------------------------------------------------------------
// It may be a server that is simply off right now, or it may be a typo — and
// those look identical from here. Dropping it would silently erase a line the
// user wrote, and the next save would write the list back WITHOUT it. So it
// renders, marked as unmeasured, with no price invented for it.

const CONNECTED_MARK = '●';
const UNPROTECTED_MARK = '○';

/**
 * Decimal (base 1000), identical to `bin/oxidegate-savings.mjs` and
 * `lib/mcp-notices.mjs`. Three copies now; they must agree, because the same
 * server priced differently in the report, the toast and this selector reads
 * as three different measurements of one thing.
 */
function humanizeBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes < 1000) return `${bytes} B`;
  const kb = Math.round((bytes / 1000) * 10) / 10;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  const mb = Math.round((bytes / 1_000_000) * 10) / 10;
  return `${mb.toFixed(1)} MB`;
}

export function buildEditorState({ snapshot, protection, switchResult }) {
  if (!snapshot || snapshot.status !== 'known') {
    return { status: 'no-inventory', reason: snapshot?.reason ?? 'unknown' };
  }

  const protectedNames = protection?.status === 'known' ? protection.servers : [];
  const protectedSet = new Set(protectedNames);

  const rows = snapshot.servers.map((server) => ({
    name: server.name,
    price: server.price,
    protected: protectedSet.has(server.name),
    knownToSnapshot: true,
  }));

  // Protected names the snapshot never mentioned. See the header — dropping
  // them would erase what the user wrote the next time they save.
  for (const name of protectedNames) {
    if (!rows.some((row) => row.name === name)) {
      rows.push({ name, price: undefined, protected: true, knownToSnapshot: false });
    }
  }

  return {
    status: 'ready',
    disableByDefault: switchResult?.status === 'known' ? switchResult.enabled : false,
    rows,
    cursor: 0,
  };
}

export function moveCursor(state, delta) {
  if (state.status !== 'ready') return state;
  const last = state.rows.length - 1;
  const cursor = Math.min(Math.max(state.cursor + delta, 0), Math.max(last, 0));
  return { ...state, cursor };
}

export function toggleAtCursor(state) {
  if (state.status !== 'ready' || state.rows.length === 0) return state;
  const rows = state.rows.map((row, i) => (i === state.cursor ? { ...row, protected: !row.protected } : row));
  return { ...state, rows };
}

export function toggleDisableByDefault(state) {
  if (state.status !== 'ready') return state;
  return { ...state, disableByDefault: !state.disableByDefault };
}

/**
 * The object written to `~/.config/oxidegate-lens/config.json`. Exactly the
 * two keys that file owns — anything else the user put there is preserved by
 * the CALLER, which merges; this function only reports what the editor
 * decided.
 */
export function toConfig(state) {
  return {
    disableByDefault: state.disableByDefault,
    protectedMcpServers: state.rows.filter((row) => row.protected).map((row) => row.name),
  };
}

/**
 * Lo que se escribe en `config.json`: lo que ya hubiera, con nuestras dos
 * claves encima.
 *
 * Fusiona en vez de sobrescribir porque el fichero es del USUARIO, no de este
 * selector. Puede tener claves que aquí no se muestran, y borrarlas al
 * guardar sería destruir configuración que él escribió a mano sin que nada se
 * lo advirtiera. Cuando lo previo no es un objeto usable se parte de cero: un
 * fichero ilegible no tiene claves rescatables, y adivinarlas sería peor.
 */
export function mergeIntoConfig(existing, state) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return { ...base, ...toConfig(state) };
}

/**
 * La portada.
 *
 * El selector es lo primero que abre quien viene a configurar esto, y no
 * decía ni cómo se llama ni quién lo firma: parecía un script prestado.
 *
 * Se mantiene en UNA caja de ancho fijo y con caracteres de dibujo estándar
 * a propósito. Un banner ASCII de cinco líneas se ve precioso el primer día
 * y estorba a partir del segundo, y encima se rompe en cuanto la terminal
 * baja de 80 columnas — que es justo donde vive un TUI.
 *
 * La versión va inyectada, no leída de disco: este módulo es puro, y quien
 * conoce el package.json es la cáscara. Sin versión no se imprime hueco
 * alguno, misma disciplina que con configPath — una etiqueta con la nada
 * detrás es peor que no poner la etiqueta.
 */
const ANCHO_PORTADA = 49;

function renderPortada({ version } = {}) {
  // Se compone el interior y se RELLENA hasta el ancho, en vez de calcular
  // huecos a mano. La primera versión restaba longitudes una a una y salió
  // torcida por contar seis caracteres como cinco: el borde derecho no
  // cuadraba con la esquina. Un padEnd no se equivoca al contar, y el test
  // que compara los anchos lo caza si alguien vuelve a intentarlo.
  const sello = version ? `v${version}` : '';
  const titulo = 'OXIDEGATE · LENS';
  const hueco = Math.max(ANCHO_PORTADA - 4 - titulo.length - sello.length, 1);

  const fila = (texto) => `  │  ${texto.padEnd(ANCHO_PORTADA - 2)}│`;

  return [
    `  ╭${'─'.repeat(ANCHO_PORTADA)}╮`,
    fila(`${titulo}${' '.repeat(hueco)}${sello}`),
    fila('by JaviLazaro'),
    `  ╰${'─'.repeat(ANCHO_PORTADA)}╯`,
    '',
  ];
}

export function renderEditor(state, { configPath, version } = {}) {
  if (state.status !== 'ready') {
    return [
      ...renderPortada({ version }),
      '  No se pudo leer el inventario de servidores MCP.',
      `  Razón: ${state.reason}.`,
      '',
      '  La lista sale del snapshot de mcp-savings, que es lo único que conoce',
      '  los nombres Y su precio sin depender del harness. Instala y ejecuta',
      '  mcp-savings para tenerlo. Esto NO significa que no tengas servidores',
      '  MCP: significa que no se sabe cuáles son.',
      '',
    ].join('\n');
  }

  const lines = [...renderPortada({ version })];
  lines.push('  Servidores MCP · qué arranca conectado');
  lines.push('');

  const width = Math.max(...state.rows.map((r) => r.name.length), 10);
  state.rows.forEach((row, i) => {
    const cursor = i === state.cursor ? '›' : ' ';
    const mark = row.protected ? CONNECTED_MARK : UNPROTECTED_MARK;
    const price = row.price?.status === 'known' ? humanizeBytes(row.price.bytes) : 'sin medir';
    // El destino de una fila depende de DOS cosas, no de una: su marca y el
    // estado de la válvula. Antes sólo miraba la marca, así que con la
    // válvula apagada la fila seguía prometiendo "se desconecta al arrancar"
    // mientras el pie lo desmentía tres líneas más abajo. La fila se lee
    // primero: un dato falso corregido después sigue siendo un dato falso.
    const fate = !state.disableByDefault || row.protected ? 'se queda' : 'se apaga';
    const note = row.knownToSnapshot ? '' : '  (no está en el snapshot: apagado, o nombre mal escrito)';
    lines.push(`  ${cursor} ${mark} ${row.name.padEnd(width)}  ${price.padStart(9)}   ${fate}${note}`);
  });

  lines.push('');
  if (state.disableByDefault) {
    // El ahorro se suma AQUÍ y no en ningún otro sitio: los precios ya
    // estaban por fila y nadie los totalizaba, así que el usuario tenía que
    // sumar de cabeza para saber qué gana con su configuración.
    const ahorro = state.rows
      .filter((r) => !r.protected && r.price?.status === 'known')
      .reduce((total, r) => total + r.price.bytes, 0);
    const cola = ahorro > 0 ? `  ·  ahorras ${humanizeBytes(ahorro)} por petición` : '';
    lines.push(`  Al arrancar se apagan los NO marcados${cola}`);
  } else {
    // Marcar protegidos con el interruptor apagado no protege de nada. Dejar
    // que el usuario rellene esa lista sin decírselo es dejarle configurar el
    // vacío. Y NO se anuncia ahorro: prometer uno que no va a ocurrir es peor
    // que callarse.
    lines.push('  VÁLVULA APAGADA — no se apaga ninguno, y las marcas no hacen nada.');
    lines.push('  Pulsa d para encenderla.');
  }

  // La leyenda va SIEMPRE, no detrás de una tecla de ayuda. Sin ella las
  // teclas se descubren pulsando, y una de ellas apaga la función entera:
  // así es exactamente como un usuario acabó con la válvula desactivada
  // creyendo que había apagado un servidor (issue #25).
  lines.push('');
  lines.push('  ↑↓ mover   espacio marcar   d válvula   enter guardar   q salir');

  // QUIÉN aplica esto. Decir sólo dónde se guarda deja a un usuario de pi o
  // de Codex CLI creyendo que ha configurado algo: guarda bien, y no lo lee
  // nadie. Un fallo silencioso sin error que buscar es el peor de los que
  // caben aquí, y cuesta dos líneas evitarlo.
  lines.push('');
  if (configPath) lines.push(`  Se guarda en: ${configPath}`);
  lines.push('  Lo aplica: el plugin de OpenCode. En pi, Codex CLI u otros harnesses');
  lines.push('  este fichero se guarda pero HOY no lo lee nadie.');

  return lines.join('\n');
}
