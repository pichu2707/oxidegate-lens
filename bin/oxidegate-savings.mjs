#!/usr/bin/env node

// oxidegate-savings.mjs
//
// CONTRACT
// --------
// This script SHOWS. It does not CONCLUDE. That distinction is the whole
// design after seven adversarial review rounds each found a defect, and
// every single defect was the same shape: a causal claim about why bytes
// were or weren't on the wire ("the proxy induced this", "this client
// already defers", "your harness is withholding this"). A presentation
// layer that infers causes has to be right about the world, not just about
// its own data — and this repo's README says it plainly: it reads
// OxideGate's data, it NEVER measures anything on its own. Concluding a
// cause is a kind of measuring this repo cannot do. So it stopped.
//
// What's left are THREE INDEPENDENT SECTIONS, printed one after another,
// never merged into a single verdict:
//
//   (a) THE TABLE — bytes. The only verdict this script is entitled to.
//       kind === 'mcp'    -> always "sí, desconectándolo". The row EXISTING
//                            in tools_by_server IS the proof its bytes are
//                            on the wire, unconditionally.
//       kind === 'native' -> always "no, sólo con --tools".
//       Neither cell EVER reads `deferred_tools` or the `client` header.
//
//   (b) DECLARED VS. ARRIVED — a fact, stated as a fact, no cause attached.
//       How many MCP servers are AVAILABLE (`claude mcp list`, read on this
//       machine) vs. how many arrived on the wire for this request
//       (`tools_by_server`). If some are missing, this script names them and
//       STOPS — it does not pick between "your harness is withholding them"
//       and "they haven't finished connecting yet". Both are real, measured
//       causes of absence (see `docs/optimizer-tool-search.md` §3.1.4 in
//       OxideGate: a remote connector was absent in request #1 and present,
//       unmarked, in request #3 seven seconds later, with nobody asking for
//       it) and a single request cannot tell them apart.
//
//   (c) CONTEXT TOKENS — its own currency, its own labeled block. Whether
//       each server's schema also occupies the model's context window
//       up front, or only on demand (`deferred_tools`). This NEVER changes
//       a byte of (a) — it says so explicitly, every time it prints.
//
// Plus ONE caveat block (not a per-row cell, not a verdict): a warning that
// harnesses which defer natively can fall back to eager loading behind a
// non-first-party ANTHROPIC_BASE_URL — which OxideGate is — so bytes seen
// through this proxy may be inflated by the proxy's own presence. It tells
// the reader how to check for themselves (repeat the request without the
// proxy) instead of deciding it for them.
//
// Reads (env):
//   OXIDEGATE_LENS_URL  - full base URL of the OxideGate proxy. Takes precedence.
//   OXIDEGATE_PORT      - used to build "http://127.0.0.1:<port>". Defaults to 8080.
//
// Reads (HTTP):
//   GET /requests  - the newest entry carrying a `tools_by_server` breakdown.
//                    Reads `tools_by_server[i].bytes/kind/server` for (a),
//                    and the separate, token-domain `deferred_tools` per
//                    server for (c) only — see the CATEGORY ERROR note below.
//   GET /stats     - how many requests that (upstream, model) has served, so
//                    (a)'s savings line can also report cumulative bytes.
//
// Reads (local, via lib/mcp-config.mjs):
//   `claude mcp list` - the MCP servers available on THIS machine, for (b).
//                    OxideGate only ever sees what arrived on the wire,
//                    never what a harness chose to withhold before sending.
//                    This is the one comparison a proxy cannot do and this
//                    script, running locally, can.
//
// Writes (stdout): the table, then (b), then (c), then the caveat block,
// then a closing note. No single line summarizes "the" answer, because
// there isn't one — see the three sections above.
//
// WHAT THIS REPORTS, AND WHAT IT DOES NOT
// ---------------------------------------
// It reports BYTES, never tokens and never dollars. Every provider tokenises
// differently (Anthropic ~2.7 bytes/token on real traffic, llama ~4.1), so
// converting these bytes into tokens would need a per-model constant we do
// not have, and converting them into dollars would compound that guess with
// a pricing guess. A byte measured on the wire is a fact. A token inferred
// from it is a conjecture.
//
// CATEGORY ERROR THIS FILE ONCE MADE, AND WHY `deferred_tools` NEVER TOUCHES
// A BYTE CLAIM AGAIN
// ------------------------------------------------------------------
// `defer_loading: true` does NOT remove bytes from the wire. It is a flag ON
// a tool definition that still ships IN FULL in the request body.
// Anthropic's `tool_search` is a SERVER-SIDE tool — it searches definitions
// *declared in the request*, so those definitions have to be there for the
// server to find them. Deferral keeps a schema out of the MODEL'S CONTEXT
// WINDOW. It says nothing about what travelled on the wire.
// (Source of truth: OxideGate's docs/optimizer-tool-search.md §2.2 and §3.2.)
//
// An earlier version of this file let `deferred_tools` decide the table
// cell, and then a later version let it decide a per-server hedge instead of
// a body-wide one — finer-grained wrong is still wrong. The fix is not a
// better split of the bytes verdict. It's refusing to let `deferred_tools`
// reach the bytes verdict at all. It lives ONLY in section (c), its own
// currency, printed separately and after the bytes table, never folded in.
//
// WHY THE OLD `clasificación:` LINE, `classifyMcpRetention`, AND
// `isClaudeCode` GATING ARE GONE
// ------------------------------------------------------------------
// They existed to name a CAUSE for absence — WITHHELD, NOTHING_WITHHELD,
// EAGER_DIALECT, and so on — and to let the request's `User-Agent`
// (client-controlled, never verifiable) decide whether an extra sentence
// printed. Every one of the seven review rounds this repo went through
// found a new world-case where the named cause was wrong: a spoofed
// User-Agent, a user who disabled `ENABLE_TOOL_SEARCH` themselves, a server
// that was merely still connecting. The bug was never a coding bug — the
// tool was trying to conclude something the wire does not contain. Section
// (b) below reports the same subtraction with NO cause attached, and
// `client` is now printed once, in the header line, purely informational —
// it decides nothing, not even one extra sentence.

import { readDeclaredMcpServers, sanitizeServerName } from '../lib/mcp-config.mjs';

const DEFAULT_PORT = 8080;

// This is an interactive command a human runs on purpose, so it can afford to
// wait. Two seconds for a localhost round trip is fine; a blank terminal
// because we gave up after 300ms is not.
const FETCH_TIMEOUT_MS = 2000;

function resolveBaseUrl() {
  if (process.env.OXIDEGATE_LENS_URL) return process.env.OXIDEGATE_LENS_URL;
  const port = process.env.OXIDEGATE_PORT ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

// Decimal (base 1000), mirroring OxideGate's own `format_bytes`.
//
// Two boundaries matter and both have bitten us:
//   - Below 1000 bytes we print the exact count. Rendering 77 B as "0.1 kB"
//     rounds a real number down to something that reads as noise.
//   - The jump to MB is decided AFTER rounding, otherwise 999,950 B renders
//     as "1000.0 kB" instead of "1.0 MB" — a number that reads like a typo.
function humanizeBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes < 1000) return `${bytes} B`;
  const kb = Math.round((bytes / 1000) * 10) / 10;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  const mb = Math.round((bytes / 1_000_000) * 10) / 10;
  return `${mb.toFixed(1)} MB`;
}

function pad(value, width, align = 'left') {
  const text = String(value);
  if (text.length >= width) return text;
  const filler = ' '.repeat(width - text.length);
  return align === 'right' ? filler + text : text + filler;
}

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${path} devolvió ${res.status}`);

  // El puerto por defecto (8080) es de los más disputados que hay: si el
  // usuario tiene CUALQUIER otro servicio web ahí, `fetch` va a traer HTML y
  // `res.json()` va a reventar con "Unexpected token '<'" — un mensaje que no
  // le dice a nadie qué hacer. Comprobamos el content-type ANTES de parsear,
  // para poder nombrar la causa real en vez de escupir un error de sintaxis.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new Error(
      `${baseUrl} responde, pero no es OxideGate: ${path} devolvió ` +
        `"${contentType || 'sin content-type'}" en vez de JSON.\n` +
        `Seguramente tienes otro servicio en ese puerto. Comprueba el puerto real ` +
        `del proxy y pásalo en OXIDEGATE_PORT (o la URL completa en OXIDEGATE_LENS_URL).`,
    );
  }
  return res.json();
}

/**
 * Newest request that carries a per-server tools breakdown.
 * `/requests` is oldest-first, so we scan backwards.
 * A row with an EMPTY `tools_by_server` declared no tools at all; it is not a
 * usable source, and is skipped rather than reported as "zero servers".
 */
function newestBreakdown(requests) {
  return [...requests]
    .reverse()
    .find((r) => Array.isArray(r?.tools_by_server) && r.tools_by_server.length > 0);
}

/** How many requests the proxy has served for this (upstream, model). */
function requestsSeen(stats, upstream, model) {
  const row = stats.find((s) => s.upstream === upstream && s.model === model);
  return row?.requests ?? null;
}

const bucketNames = (list) => list.join(', ');

/**
 * Section (b): the declared-vs-arrived SUBTRACTION, no cause attached.
 * `declared` must already be `{ status: 'known', servers }` — callers check
 * that before calling this. `entry` is the request row shown in the table.
 *
 * This does NOT decide why any server is missing. See the module header for
 * why: absence has at least four possible causes (withheld, still
 * connecting, failed to connect, different scope) and one request cannot
 * distinguish them. This function only counts.
 *
 * TWO WAYS THIS SUBTRACTION CAN BE UNABLE TO NAME AN IDENTITY WITH
 * CERTAINTY — both are reported as uncertainty, never guessed past:
 *
 *   1. COLLISION. `sanitizeServerName` is NOT injective: distinct declared
 *      names can sanitize to the same wire name (`"foo bar"` and `"foo_bar"`
 *      both -> `"foo_bar"`). A declared name involved in a collision is
 *      EXCLUDED from `available`/`missing` — we cannot tell which (or how
 *      many) of the colliding names a single arrived row of that sanitized
 *      name corresponds to — and reported separately in `collisions`.
 *   2. OVERFLOW. OxideGate individually tracks only `MAX_TOOL_SERVERS` (32,
 *      `src/provider/mod.rs` in OxideGate) distinct servers per request;
 *      the rest collapse into one anonymous `kind: "others"` row. A
 *      sanitized name absent from `arrivedSet` is NOT reliably "did not
 *      arrive" when an `(others)` row is present — its bytes may be sitting
 *      inside that bucket, unnamed. `hasOthersBucket` flags this so the
 *      caller can degrade "missing" into "not individually confirmed".
 */
function declaredVsArrived(entry, declared) {
  const connected = declared.servers.filter((s) => s.connected);

  const bySanitized = new Map();
  for (const s of connected) {
    const key = sanitizeServerName(s.name);
    if (!bySanitized.has(key)) bySanitized.set(key, []);
    bySanitized.get(key).push(s.name);
  }

  const collisions = [...bySanitized.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([sanitized, names]) => ({ sanitized, names }));

  // Only sanitized names with EXACTLY ONE declared name behind them can be
  // subtracted with certainty; a colliding key contributes to neither
  // `available` nor `missing` — it is reported once, in `collisions`.
  const resolvableKeys = [...bySanitized.keys()].filter((k) => bySanitized.get(k).length === 1);

  const rows = entry.tools_by_server ?? [];
  const arrivedSet = new Set(rows.filter((r) => r.kind === 'mcp').map((r) => r.server));
  const hasOthersBucket = rows.some((r) => r.kind === 'others');

  const missing = resolvableKeys.filter((n) => !arrivedSet.has(n));
  return { available: resolvableKeys.length, missing, collisions, hasOthersBucket };
}

// Section (c): CONTEXT-TOKEN state, per server — a DIFFERENT currency from
// the bytes table (a). Never feeds the bytes table. Only feeds this block.
//
//   CTX_ALL_DEFERRED       - every tool this server declared carries
//                             `defer_loading: true`. The schema still ships
//                             in full on the wire; it just doesn't have to
//                             sit in the model's context unless searched.
//   CTX_NONE_DEFERRED      - none are deferred: occupies context in full.
//   CTX_PARTIALLY_DEFERRED - some are, some aren't: a mix inside one row.
//   CTX_UNKNOWN             - this row has no `deferred_tools` (an
//                             OxideGate build older than the field). The
//                             row's BYTES are still fully known (see the
//                             table) — only its context-token state isn't.
function classifyRowContext(r) {
  if (typeof r.deferred_tools !== 'number') return 'CTX_UNKNOWN';
  if (r.tools > 0 && r.deferred_tools === r.tools) return 'CTX_ALL_DEFERRED';
  if (r.deferred_tools === 0) return 'CTX_NONE_DEFERRED';
  return 'CTX_PARTIALLY_DEFERRED';
}

async function main() {
  const baseUrl = resolveBaseUrl();
  const [requests, stats] = await Promise.all([
    getJson(baseUrl, '/requests'),
    getJson(baseUrl, '/stats'),
  ]);

  if (!Array.isArray(requests) || requests.length === 0) {
    process.stderr.write('oxidegate-lens: the proxy has not seen any request yet.\n');
    process.exit(1);
  }

  const entry = newestBreakdown(requests);
  if (!entry) {
    process.stderr.write(
      'oxidegate-lens: no request carries a tools_by_server breakdown.\n' +
        'The proxy may predate that field, or no request declared tools.\n',
    );
    process.exit(1);
  }

  const isAnthropic = entry.upstream === 'anthropic';

  // Only fetch declared config for the dialect where section (b) can mean
  // anything: `defer_loading` + withholding-before-the-wire is an
  // Anthropic-dialect primitive (docs/optimizer-tool-search.md §8 in
  // OxideGate). Skipping it for other dialects avoids an unnecessary
  // `claude` process spawn on traffic that could never use it.
  const declared = isAnthropic ? await readDeclaredMcpServers() : { status: 'not-applicable' };

  const toolsBytes = entry.context_tools_bytes ?? null;
  const seen = requestsSeen(stats, entry.upstream, entry.model);

  const rows = [...entry.tools_by_server].sort((a, b) => b.bytes - a.bytes);
  const removable = rows.filter((r) => r.kind === 'mcp');
  const removableBytes = removable.reduce((sum, r) => sum + r.bytes, 0);
  const n = removable.length;

  const share = (bytes) => (toolsBytes ? `${((bytes / toolsBytes) * 100).toFixed(1)}%` : '-');

  process.stdout.write(
    `fuente: ${entry.timestamp ?? '-'}  ${entry.model ?? '-'}  (${entry.upstream ?? '-'})` +
      `  cliente: ${entry.client ?? 'desconocido'}\n\n`,
  );

  // ---------------------------------------------------------------------
  // (a) THE TABLE — bytes. mcp is ALWAYS "sí, desconectándolo": its row
  // existing in tools_by_server IS the proof its bytes are on the wire.
  // native is ALWAYS "no, sólo con --tools". Neither cell reads
  // `deferred_tools` or `client` — see the module header.
  // ---------------------------------------------------------------------
  const row = (server, kind, tools, bytes, pct, note) =>
    `${pad(server, 28)}  ${pad(kind, 7)}  ${pad(tools, 5, 'right')}  ` +
    `${pad(bytes, 10, 'right')}  ${pad(pct, 8, 'right')}  ${note}\n`;

  process.stdout.write(row('SERVIDOR', 'KIND', 'TOOLS', 'BYTES', '% TOOLS', '¿SE PUEDE QUITAR?'));

  for (const r of rows) {
    const removableNote =
      r.kind === 'mcp' ? 'sí, desconectándolo' : r.kind === 'native' ? 'no, sólo con --tools' : '-';
    process.stdout.write(
      row(r.server, r.kind, r.tools, humanizeBytes(r.bytes), share(r.bytes), removableNote),
    );
  }

  const overhead = entry.tools_overhead_bytes;
  if (overhead !== null && overhead !== undefined) {
    process.stdout.write(
      row('overhead (corchetes/comas)', '-', '-', humanizeBytes(overhead), '-', ''),
    );
  }
  process.stdout.write('\n');

  const serversPhrase = n === 1 ? 'el servidor MCP' : `los ${n} servidores MCP`;

  if (n === 0) {
    process.stdout.write('no hay servidores MCP en esta petición: nada que quitar en bytes.\n');
  } else {
    process.stdout.write(
      `ahorro por petición desconectando ${serversPhrase}: ${humanizeBytes(removableBytes)}` +
        (toolsBytes ? ` (${share(removableBytes)} de los tools)` : '') +
        '\n',
    );
    if (seen) {
      const reqWord = seen === 1 ? 'petición observada' : 'peticiones observadas';
      process.stdout.write(
        `ya re-enviados en ${seen} ${reqWord}: ${humanizeBytes(removableBytes * seen)}\n`,
      );
      if (seen > requests.length) {
        process.stdout.write(
          `aviso: este número asume que la tabla de arriba fue representativa en las ${seen}\n` +
            `peticiones — pero sólo se pueden ver las últimas ${requests.length} (el buffer en\n` +
            'memoria de OxideGate). Si el conjunto de servidores en el cable cambió antes de eso,\n' +
            'ya rotó fuera del buffer y esta cuenta no lo vería: tratá el número de arriba como\n' +
            'una extrapolación, no como un hecho verificado en toda la ventana.\n',
        );
      }
    }
    if (!isAnthropic) {
      process.stdout.write(
        `Este dialecto (${entry.upstream}) no tiene primitivo de diferido: no existe una versión\n` +
          'donde estos bytes sean opcionales, para ningún harness. El costo de arriba es real,\n' +
          'sin ambigüedad — nada que decidir aquí.\n',
      );
    }
  }

  // ---------------------------------------------------------------------
  // (b) DECLARED VS. ARRIVED — a fact, no cause attached. Anthropic-only:
  // withholding before the wire is a dialect-specific primitive.
  // ---------------------------------------------------------------------
  if (isAnthropic) {
    process.stdout.write('\n');
    if (declared.status !== 'known') {
      const reasonText = {
        'claude-not-found': 'no se encontró el comando `claude` en el PATH',
        timeout: '`claude mcp list` no respondió a tiempo',
        'command-failed': '`claude mcp list` devolvió un error',
        unparseable: 'la salida de `claude mcp list` no tuvo el formato esperado',
      }[declared.reason ?? ''] ?? 'razón desconocida';
      process.stdout.write(
        `no se pudo leer cuántos servidores MCP tienes disponibles (${reasonText}):\n` +
          'no hay forma de comparar disponible contra llegado para esta petición. Esto es\n' +
          'DISTINTO de "0 servidores disponibles" — no es un cero, es un dato que no se pudo leer.\n',
      );
    } else {
      const cmp = declaredVsArrived(entry, declared);

      // Collisions first: `sanitizeServerName` is lossy, so a colliding
      // name's identity is unresolvable from this data at all — reported as
      // its own honest-uncertainty note, never folded into a count.
      for (const c of cmp.collisions) {
        process.stdout.write(
          `no se puede saber si llegaron ${c.names.map((n) => `"${n}"`).join(' y ')}: los dos\n` +
            `sanitizan al mismo nombre en el cable ("${c.sanitized}") y sanitizeServerName() no es\n` +
            'inyectiva — no hay forma de distinguirlos en tools_by_server. No cuentan ni como\n' +
            'disponibles ni como llegados en lo que sigue.\n',
        );
      }

      const suffix = cmp.collisions.length > 0 ? ' (sin contar los ambiguos de arriba)' : '';

      if (cmp.available === 0) {
        if (cmp.collisions.length === 0) {
          process.stdout.write('no tienes servidores MCP disponibles: nada que restar aquí.\n');
        }
      } else if (cmp.missing.length === 0) {
        process.stdout.write(
          `Tienes ${cmp.available} servidor(es) MCP disponibles${suffix}. En esta petición llegaron los ${cmp.available}.\n`,
        );
      } else if (cmp.hasOthersBucket) {
        // The overflow bucket makes "missing" structurally unconfirmable:
        // OxideGate tracks only MAX_TOOL_SERVERS servers individually per
        // request (src/provider/mod.rs in OxideGate); anything beyond that
        // is still counted, but merged into one anonymous "(others)" row.
        // A sanitized name absent from the individual rows may still be
        // sitting, unnamed, inside that bucket.
        process.stdout.write(
          `Tienes ${cmp.available} servidor(es) MCP disponibles${suffix}. ${cmp.missing.length} de ellos\n` +
            `(${bucketNames(cmp.missing)}) no tienen fila propia en la tabla — pero esta petición trae\n` +
            'una fila "(others)": OxideGate sólo trackea servidores individualmente hasta un tope\n' +
            '(ver la tabla arriba), y el resto se cuenta pero se funde en ese bucket sin nombre. No\n' +
            'se puede confirmar si alguno de estos está adentro de "(others)" o si de verdad no\n' +
            'llegó — esta petición sola no alcanza para saberlo.\n',
        );
      } else {
        const arrived = cmp.available - cmp.missing.length;
        process.stdout.write(
          `Tienes ${cmp.available} servidor(es) MCP disponibles${suffix}. En esta petición llegaron ${arrived}.\n` +
            `Los otros ${cmp.missing.length} (${bucketNames(cmp.missing)}) no viajan ahora mismo.\n` +
            'Puede ser que tu harness los esté reteniendo, o que todavía no hayan conectado —\n' +
            'ninguna de las dos causas se puede confirmar desde esta sola petición (medido:\n' +
            'docs/optimizer-tool-search.md §3.1.4 en OxideGate).\n',
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // (c) CONTEXT TOKENS — its own currency, its own block. Never touches (a).
  // ---------------------------------------------------------------------
  if (isAnthropic && n > 0) {
    process.stdout.write(
      '\ntokens de contexto (otra moneda — NO bytes, no cambia nada de la tabla de arriba):\n',
    );
    for (const r of removable) {
      const ctx = classifyRowContext(r);
      const line =
        ctx === 'CTX_ALL_DEFERRED'
          ? `fuera del contexto del modelo salvo que lo busque (${r.deferred_tools}/${r.tools} tools diferidas; sus bytes siguen completos arriba)`
          : ctx === 'CTX_NONE_DEFERRED'
            ? 'ocupa el contexto completo por adelantado (0 tools diferidas)'
            : ctx === 'CTX_PARTIALLY_DEFERRED'
              ? `parcial: ${r.deferred_tools}/${r.tools} tools diferidas de contexto, el resto ocupa contexto completo`
              : 'desconocido — este build de OxideGate no reporta `deferred_tools` para esta fila (los bytes de arriba sí se conocen igual)';
      process.stdout.write(`  - ${r.server}: ${line}\n`);
    }
  }

  // ---------------------------------------------------------------------
  // CAVEAT — not a verdict, not a per-row cell. Applies only where a
  // deferral primitive exists to fall back FROM. Never gated by `client`:
  // the User-Agent is unverifiable and must never decide a byte claim.
  // ---------------------------------------------------------------------
  if (isAnthropic) {
    process.stdout.write(
      '\naviso: algunos harnesses (p. ej. Claude Code) difieren esquemas MCP por defecto, pero ese\n' +
        'diferido se cae a carga completa detrás de un ANTHROPIC_BASE_URL que no sea de Anthropic —\n' +
        'y OxideGate es exactamente eso. Si tu harness es de ese tipo, una parte de los bytes de\n' +
        'la tabla de arriba podría ser un artefacto de tener el proxy en el medio, no un costo que\n' +
        'exista sin él. Esta ejecución no lo puede decidir por ti: para comprobarlo, repite la misma\n' +
        'petición apuntando directo a Anthropic (sin pasar por OxideGate) y compara los bytes.\n' +
        'Detalle medido: docs/optimizer-tool-search.md §3 en el repo de OxideGate.\n',
    );
  }

  process.stdout.write(
    '\nnota: son BYTES medidos en el cable, no tokens ni dólares. Cada proveedor\n' +
      'tokeniza distinto, así que convertirlos exigiría una constante que no se tiene.\n' +
      'Un byte medido es un hecho; un token inferido, una conjetura.\n',
  );

  // El párrafo de `defer_loading` referencia el bloque (c). Solo tiene sentido
  // si (c) se imprimió: misma guarda, o la nota apunta a algo que no está en
  // pantalla.
  if (isAnthropic && n > 0) {
    process.stdout.write(
      '`defer_loading` (bloque «tokens de contexto» más arriba) no cambia esta nota: marca un\n' +
        'esquema que igual viaja entero en el body — medido, marcarla CUESTA 21 bytes y no quita\n' +
        'ninguno. Diferido ahorra contexto, no cable.\n',
    );
  }

  // Same discipline as the `defer_loading` paragraph above: this note
  // describes the `native` row, so it only prints when that row actually
  // exists on screen. Printing it unconditionally would reference something
  // not printed — measured: a request declaring only `mcp__probe__x` tools
  // (no native surface at all) still got this line under the old code.
  const hasNativeRow = rows.some((r) => r.kind === 'native');
  if (hasNativeRow) {
    process.stdout.write(
      'Las filas `native` no se quitan desconectando nada: sólo con `--tools <lista>`,\n' +
        'que cambia lo que el agente PUEDE HACER, no sólo lo que carga.\n',
    );
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`oxidegate-lens: ${err?.message ?? 'unknown error'}\n`);
  process.exit(1);
}
