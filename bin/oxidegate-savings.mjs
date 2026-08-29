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
// Reads (env) — all OPTIONAL. With none of them set, the endpoint is
// discovered: see `lib/mcp-endpoint.mjs`, which owns the ordering and the
// rule that nothing is accepted without proving it is OxideGate.
//   OXIDEGATE_LENS_URL  - full base URL. A PIN: nothing else is probed.
//   OXIDEGATE_PORT      - builds "http://127.0.0.1:<port>". A HINT: if the
//                         proxy is not there, discovery continues and says so.
//
// Reads (disk):
//   ~/.config/oxidegate/proxy.log - OxideGate's own "Escuchando en <url>"
//                                   line. Tolerant: absent means keep looking.
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

import { readFileSync, rmSync } from 'node:fs';

import { readDeclaredMcpServers, sanitizeServerName } from '../lib/mcp-config.mjs';
import { readMcpSavingsSnapshot } from '../lib/mcp-snapshot.mjs';
import { observeMcpUsage } from '../lib/mcp-usage.mjs';
import { buildValveRows } from '../lib/mcp-valve.mjs';
import { readProtectedServers, readDisableByDefault } from '../lib/mcp-protection.mjs';
import { diagnose } from '../lib/mcp-doctor.mjs';
import { readProjectConfig, readApprovals } from '../lib/mcp-project-config.mjs';
import { buildEndpointCandidates, chooseEndpoint, readProxyLogUrl } from '../lib/mcp-endpoint.mjs';
import {
  resolveOpenCodeCachePath,
  readCachedPluginVersion,
  diagnoseCache,
} from '../lib/mcp-opencode-cache.mjs';

const DEFAULT_PORT = 8080;

// This is an interactive command a human runs on purpose, so it can afford to
// wait. Two seconds for a localhost round trip is fine; a blank terminal
// because we gave up after 300ms is not.
const FETCH_TIMEOUT_MS = 2000;

/**
 * La versión que ESTÁ CORRIENDO, leída del propio package.json del paquete.
 *
 * Se lee del disco y no se escribe a mano en una constante a propósito: una
 * versión duplicada en el código es una que alguien olvidará subir en la
 * siguiente release, y entonces el diagnóstico de la caché compararía contra
 * un número inventado. Ilegible se queda en null, y el módulo lo traduce a
 * `unknown` — nunca a un "todo en orden".
 */
const LENS_VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version;
  } catch {
    return null;
  }
})();

/**
 * Encuentra el proxy sin preguntarle el puerto al usuario.
 *
 * Aquí solo se RECOGE: se lee el log de OxideGate y se sondea la red.
 * Quién gana lo decide `lib/mcp-endpoint.mjs`, que no toca ni disco ni red.
 *
 * El sondeo reutiliza `probeRequests`, que es el mismo que usa `--doctor`:
 * la comprobación de identidad que ya existía deja de estar solo detrás de
 * un flag y pasa al camino normal. Ese era el fallo — el diagnóstico
 * correcto estaba escrito y no se ejecutaba salvo que ya sospecharas.
 */
async function discoverEndpoint() {
  const candidates = buildEndpointCandidates({
    env: process.env,
    loggedUrl: readProxyLogUrl({}),
  });

  const found = await chooseEndpoint({
    candidates,
    verify: async (baseUrl) => {
      const { reachable, rows } = await probeRequests(baseUrl);
      return { reachable, isOxidegate: Array.isArray(rows) };
    },
  });

  // Si no se encontró nada, se sigue adelante con el candidato MÁS
  // EXPLÍCITO, no con el primero que se nos ocurra: los mensajes de error
  // (y el doctor) tienen que hablar del sitio que el usuario tenía en la
  // cabeza. Decirle «no responde el 8899» a quien fijó el 8080 le manda a
  // investigar una máquina que no es la suya.
  const baseUrl = found.status === 'found' ? found.baseUrl : (candidates[0]?.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}`);
  return { ...found, baseUrl };
}

/**
 * El aviso de que se ignoró una orden explícita.
 *
 * Va a stderr a propósito: el stdout de esta herramienta es un reporte que
 * la gente pipea, y meterle una nota administrativa por el medio lo
 * ensucia. Pero callárselo tampoco vale — quien tenga un OXIDEGATE_PORT
 * viejo en su perfil merece enterarse, o mañana vuelve a tropezar.
 */
function announceOverride(found) {
  if (!found.overrode) return;
  process.stderr.write(
    `oxidegate-lens: ${found.overrode.baseUrl} responde, pero no es OxideGate — ` +
      `se ignora ${found.overrode.source === 'env-port' ? 'OXIDEGATE_PORT' : 'la URL configurada'}.\n` +
      `  Usando ${found.baseUrl}, que es donde ${SOURCE_LABEL[found.source] ?? 'se encontró el proxy'}.\n`,
  );
}

/**
 * Borra la copia que OpenCode guarda de ESTE paquete, y nada más.
 *
 * Es la única acción destructiva de todo el binario, así que:
 *
 *   - Va detrás de un flag explícito. Nunca como efecto secundario de mirar.
 *   - Dice la ruta ANTES de borrarla, para que se pueda leer y abortar.
 *   - Toca únicamente el directorio de este paquete. La caché de OpenCode
 *     tiene los plugins de todo el mundo dentro; llevarse por delante los
 *     ajenos para arreglar el propio sería un remedio peor que la avería.
 *   - Si no hay nada, lo dice y sale con 0. Borrar lo inexistente no es un
 *     error, y hacerlo fallar mandaría a investigar un problema que no hay.
 */
function clearOpenCodeCache() {
  const path = resolveOpenCodeCachePath({});
  const cached = readCachedPluginVersion({});

  if (cached.status === 'absent') {
    process.stdout.write(`oxidegate-lens: no hay caché que limpiar en ${path}\n`);
    return;
  }

  const version = cached.status === 'known' ? ` (tenía la ${cached.version})` : '';
  rmSync(path, { recursive: true, force: true });
  process.stdout.write(
    `oxidegate-lens: borrada la caché de OpenCode${version}\n` +
      `  ${path}\n` +
      `  Vuelve a instalar el plugin: opencode plugin oxidegate-lens\n`,
  );
}

const SOURCE_LABEL = {
  'proxy-log': 'el propio proxy dice estar escuchando',
  'known-port': 'estaba escuchando',
  'env-port': 'apunta OXIDEGATE_PORT',
  'env-url': 'apunta OXIDEGATE_LENS_URL',
};

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

function present(value) {
  return value !== null && value !== undefined;
}

function metricLine(label, pairs) {
  const facts = pairs.filter(([, value]) => present(value));
  if (facts.length === 0) return '';
  return `  ${label}: ${facts.map(([k, v]) => `${k}=${v}`).join('  ')}\n`;
}

function humanizeRatio(ratio) {
  if (!present(ratio) || Number.isNaN(ratio)) return null;
  return `${(ratio * 100).toFixed(2)}%`;
}

/**
 * Sums `rows[i][key]` — but refuses to sum at all if ANY row is silent about
 * that field (missing, non-numeric, or NaN). Same discipline as
 * `humanizeBytes()` and `classifyRowContext` applied to a TOTAL instead of a single
 * cell: a total built from `?? 0` turns "this row never said" into "this row
 * said zero", and the printed sum then reads as measured when it is really
 * partial. Zero ROWS is a different thing entirely — nobody was silent,
 * there is nothing to sum — so an empty `rows` correctly returns a real `0`,
 * not `null`. One missing field poisons only the total for THAT key.
 */
function sumOrUnknown(rows, key) {
  let sum = 0;
  for (const r of rows) {
    const value = r[key];
    if (typeof value !== 'number' || Number.isNaN(value)) return null;
    sum += value;
  }
  return sum;
}

function writeRequestDashboard(entry) {
  const rows = entry.tools_by_server ?? [];
  const totalTools = sumOrUnknown(rows, 'tools');
  const totalToolBytes = sumOrUnknown(rows, 'bytes');
  const nativeRows = rows.filter((r) => r.kind === 'native');
  const mcpRows = rows.filter((r) => r.kind === 'mcp');

  process.stdout.write('petición reciente (/requests, no /stats):\n');
  process.stdout.write(
    metricLine('identidad', [
      ['cliente', entry.client ?? 'desconocido'],
      ['ruta', entry.route],
      ['upstream', entry.upstream],
      ['modelo', entry.model],
      ['status', entry.status],
      ['stream', entry.stream],
    ]),
  );
  process.stdout.write(
    metricLine('tokens', [
      ['input', entry.input_tokens],
      ['output', entry.output_tokens],
      ['cache_read', entry.cache_read_tokens],
      ['cache_write', entry.cache_write_tokens],
    ]),
  );
  process.stdout.write(
    metricLine('contexto_bytes', [
      ['system', humanizeBytes(entry.context_system_bytes)],
      ['tools', humanizeBytes(entry.context_tools_bytes)],
      ['history', humanizeBytes(entry.context_history_bytes)],
      ['last_turn', humanizeBytes(entry.context_last_turn_bytes)],
      ['other', humanizeBytes(entry.context_other_bytes)],
      ['measured', humanizeBytes(entry.context_measured_bytes)],
      ['messages', entry.context_messages_count],
      ['tax_ratio', humanizeRatio(entry.context_tax_ratio)],
    ]),
  );
  process.stdout.write(
    metricLine('tools', [
      ['filas', rows.length],
      ['tools', totalTools ?? '-'],
      ['bytes', humanizeBytes(totalToolBytes)],
      ['overhead', humanizeBytes(entry.tools_overhead_bytes)],
    ]),
  );
  process.stdout.write(
    metricLine('latencia', [
      ['ttft_ms', entry.ttft_ms],
      ['total_ms', entry.total_ms],
      ['prepare_us', entry.prepare_us],
    ]),
  );

  if (nativeRows.length > 0 && mcpRows.length === 0) {
    process.stdout.write(
      '  caveat: esta petición no trae filas MCP individuales en tools_by_server; las filas\n' +
        '  `(native)` no atribuyen bytes a servidores MCP concretos. No hay desglose por MCP en esta fila.\n',
    );
  }

  process.stdout.write('\n');
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

// ---------------------------------------------------------------------
// (d) VALVE INFORMADO MCP — une precio (mcp-savings, vía lib/mcp-snapshot.mjs)
// con uso observado en el cable (OxideGate, vía lib/mcp-usage.mjs) por
// servidor. TODA la lógica (el join, joinHealth, la conjunción de
// recomendación) vive en lib/mcp-valve.mjs — esta sección SÓLO renderiza lo
// que ese módulo ya decidió; ninguna regla se repite ni se reinventa acá.
//
// Sigue la MISMA disciplina que (a)/(b)/(c) arriba: una ausencia nunca se
// imprime como cero, y una recomendación de "0 usos" siempre lleva su
// ventana de observación en la MISMA línea — nunca en un encabezado
// separado, nunca en un párrafo aparte. Un snapshot stale marca esa misma
// disciplina sobre CADA precio y CADA recomendación que muestra, no sólo un
// aviso genérico al principio del bloque.
// ---------------------------------------------------------------------

/** "3h", "45 min", "1h 30min" — nunca una cifra cruda de milisegundos. */
function humanizeWindowMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'ventana desconocida';
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
}

function joinLabelText(join) {
  return (
    {
      exact: 'exacto',
      sanitized: 'saneado',
      'snapshot-only': 'sólo en snapshot',
      ambiguous: 'ambiguo',
    }[join] ?? join
  );
}

/**
 * Marca de staleness, para adjuntar EN LA MISMA línea que cada precio o
 * recomendación que la usa — nunca como un aviso separado que un lector
 * podría no conectar con la cifra de abajo. `valve.snapshotTimestamp` viene
 * verbatim de `readMcpSavingsSnapshot`, así que la fecha citada es siempre
 * la medición original, nunca inventada.
 */
function staleTag(valve) {
  if (valve.snapshotFreshness !== 'stale') return '';
  const age = humanizeWindowMs(Date.now() - valve.snapshotTimestamp);
  const iso = new Date(valve.snapshotTimestamp).toISOString();
  return ` [precio DESACTUALIZADO — snapshot de hace ${age}, medido ${iso}]`;
}

/**
 * Precio de una fila del valve. NUNCA renderiza `unknown` como un `0`
 * numérico — ver la invariante de honestidad de lib/mcp-snapshot.mjs. Un
 * precio conocido pero de un snapshot stale lleva la marca de staleness EN
 * LA MISMA cadena que la cifra, nunca en una línea separada.
 */
function formatPriceForRow(row, valve) {
  if (!row.price) return 'desconocido (sin entrada de snapshot)';
  if (row.price.status !== 'known') {
    const reasonText = row.price.reason === 'cannot-measure' ? 'no se pudo medir' : 'falta el campo bytes';
    return `desconocido (${reasonText})`;
  }
  return `${humanizeBytes(row.price.bytes)}${staleTag(valve)}`;
}

/**
 * Cifra de "usos" de una fila. Un `0` real y confirmado es un hallazgo, pero
 * NUNCA se imprime desnudo — su ventana de observación va SIEMPRE en la
 * MISMA línea, para que nadie pueda ver "0 usos" sin ver también cuánto
 * tiempo se observó ese cero.
 */
function formatUsesText(row, valve) {
  if (row.uses === undefined) return 'usos: desconocido (no observable)';
  if (row.uses === 0) return `0 usos en la ventana observada de ${humanizeWindowMs(valve.windowMs)}`;
  return `usos observados: ${row.uses}`;
}

const RECOMMENDATION_REASON_TEXT = {
  'insufficient-observation': 'todavía no hay suficiente observación para juzgar uso',
  'instruments-disagree': 'los dos instrumentos no coinciden en ningún servidor',
  'not-individually-confirmed': 'hay una fila (others) en la ventana: no se puede confirmar individualmente',
  'name-collision': 'nombre ambiguo — sanitizeServerName() colisiona con otro nombre de snapshot',
  // Deliberadamente dice que esperar NO sirve. Es la diferencia con
  // 'insufficient-observation', que sí se arregla con más tráfico: aquí el
  // cable no lleva la atribución por servidor, así que más tiempo no la trae.
  'tools-flattened':
    'esta ruta aplana las tools (tools_flattened): el cable no dice de qué servidor viene cada una — esperar más NO lo cambia',
  'unattributed-spend': 'gasto observado que no se puede atribuir a este servidor',
  'price-unknown': 'no hay precio conocido para este servidor',
  'in-use': 'está en uso — nada que reportar',
};

/**
 * Recomendación de una fila. `candidate-to-disable` SIEMPRE lleva su ventana
 * de observación en la MISMA oración — nunca un "0 usos" o un "candidato a
 * desconectar" desnudo. Cuando el snapshot es stale, la marca de staleness
 * se agrega en esa MISMA oración también.
 */
function formatRecommendation(row, valve) {
  const rec = row.recommendation;
  if (!rec) return 'sin recomendación';
  if (rec.status === 'candidate-to-disable') {
    return (
      `candidato a desconectar — 0 usos en la ventana observada de ${humanizeWindowMs(valve.windowMs)}` +
      staleTag(valve)
    );
  }
  if (rec.status === 'already-off') {
    return (
      `ya está apagado — costaría ${humanizeBytes(row.price.bytes)} por petición si se habilitara` +
      staleTag(valve)
    );
  }
  const reasonText = RECOMMENDATION_REASON_TEXT[rec.reason] ?? rec.reason ?? 'razón desconocida';
  return `sin recomendación (${reasonText})`;
}

/**
 * Renderiza la sección (d) completa a partir de `snapshot`
 * (lib/mcp-snapshot.mjs), `usage` (lib/mcp-usage.mjs) y `valve`
 * (lib/mcp-valve.mjs — la unión de los dos anteriores). Nunca lanza: los
 * tres módulos que provee ya degradan defensivamente, así que esta función
 * sólo tiene que decidir CÓMO mostrar cada combinación, nunca inventar un
 * dato que ninguno de los tres le dio.
 */
function writeMcpValveSection({ snapshot, usage, valve }) {
  process.stdout.write('\nvalve informado MCP (precio de mcp-savings + uso observado por OxideGate):\n');

  if (snapshot.status !== 'known') {
    const reasonText =
      {
        'missing-file': 'no se encontró el snapshot',
        'malformed-json': 'el snapshot tiene JSON inválido',
        'unrecognized-shape': 'el snapshot no tiene la forma esperada',
        unreadable: 'no se pudo leer el archivo del snapshot',
      }[snapshot.reason] ?? 'razón desconocida';
    process.stdout.write(
      `  sin precio de mcp-savings (${reasonText}): instala y ejecuta mcp-savings para tener precio\n` +
        '  por servidor. Esto NO es un precio de 0 — es un snapshot ausente o no interpretable.\n',
    );
  } else if (valve.snapshotFreshness === 'stale') {
    process.stdout.write(
      `  aviso: el snapshot de precios está DESACTUALIZADO — tiene ${humanizeWindowMs(Date.now() - valve.snapshotTimestamp)}\n` +
        `  (medido ${new Date(valve.snapshotTimestamp).toISOString()}). Cada precio y recomendación de abajo\n` +
        '  lleva la misma marca en su propia línea.\n',
    );
  }

  const mainRows = valve.rows.filter((r) => r.join !== 'unknown');
  const unknownRows = valve.rows.filter((r) => r.join === 'unknown');

  if (mainRows.length === 0 && unknownRows.length === 0) {
    process.stdout.write(
      '  no hay datos de valve para esta ejecución (sin precio de snapshot y sin uso suficiente observado).\n',
    );
    return;
  }

  for (const row of mainRows) {
    process.stdout.write(
      `  - ${row.label} [${joinLabelText(row.join)}]: precio=${formatPriceForRow(row, valve)}  ${formatUsesText(row, valve)}\n` +
        `      ${formatRecommendation(row, valve)}\n`,
    );
  }

  // Requisito A: una fila "unknown" (gasto real, sin atribuir) es
  // CONSPICUA — su propio bloque etiquetado, nunca una fila más de la tabla
  // de arriba ni una nota al pie. Ver design.md Decisión 6.
  if (unknownRows.length > 0) {
    process.stdout.write(
      '\n  ── GASTO SIN ATRIBUIR (visto en el cable, ningún servidor del snapshot lo reclama) ──\n',
    );
    for (const row of unknownRows) {
      process.stdout.write(
        `  - ${row.label}: ${row.uses} usos observados, sin precio (ninguna entrada de snapshot corresponde)\n`,
      );
    }
    process.stdout.write(
      '  Este gasto NO se descarta: aparece acá porque las dos herramientas podrían no estar\n' +
        '  nombrando este servidor de la misma forma.\n',
    );
  }

  if (valve.joinHealth === 'no-correspondence') {
    process.stdout.write(
      '\n  aviso: los servidores medidos en el snapshot no coincidieron con NINGÚN tráfico del cable\n' +
        '  en esta ventana — las dos herramientas podrían no estar nombrando servidores igual. Ninguna\n' +
        '  recomendación de este bloque se basa en esto.\n',
    );
  }

  // El aplanado gana al pie de "observación insuficiente", por la misma razón
  // por la que gana en lib/mcp-valve.mjs: los dos mensajes implican acciones
  // OPUESTAS. Decir "todavía no alcanza" debajo de unas filas que acaban de
  // explicar que esperar no sirve es contradecirse, y el lector se queda con
  // el consejo equivocado — que además es el que le hace perder el tiempo.
  if (usage.hasFlattenedTools === true) {
    process.stdout.write(
      `\n  sin atribución por servidor en esta ruta: las ${usage.count ?? 'las'} petición(es) observadas\n` +
        '  llegan con las tools APLANADAS en un solo bloque (tools_flattened), así que el cable\n' +
        '  no dice de qué servidor viene cada una. Más tráfico no lo cambia: haría falta una ruta\n' +
        '  o un dialecto que conserve la atribución.\n',
    );
    return;
  }

  if (usage.status !== 'observed') {
    process.stdout.write(
      `\n  observación insuficiente para recomendar: ${usage.count} petición(es) en una ventana de\n` +
        `  ${humanizeWindowMs(usage.windowMs)} — todavía no alcanza para juzgar uso.\n`,
    );
  }
}

const HELP = `oxidegate-savings — qué pesa cada servidor MCP en el cable

USO:
    oxidegate-savings            El reporte completo
    oxidegate-savings --doctor   Diagnostica la cadena y dice qué eslabón falla
    oxidegate-savings --clear-opencode-cache
                                 Borra la copia del plugin que guarda OpenCode
    oxidegate-savings --help     Muestra esta ayuda

DÓNDE MIRA:
    Lo busca solo. No hace falta configurar nada.

    Por orden: OXIDEGATE_LENS_URL, si no OXIDEGATE_PORT, si no lo que el
    propio proxy declara en ~/.config/oxidegate/proxy.log, y si no los
    puertos habituales (8080, 8899).

    En TODOS los casos comprueba que quien contesta es OxideGate de verdad
    antes de creerle. Que algo responda en un puerto no lo convierte en el
    proxy: el 8080 lo suelen ocupar Apache, Tomcat o Jenkins, y un reporte
    escrito a partir de sus respuestas sería inventado.

    OXIDEGATE_LENS_URL es un PIN: si la fijas, no se busca en ningún otro
    sitio. OXIDEGATE_PORT es una pista — si ahí no está el proxy, se sigue
    buscando y se te avisa por stderr de que se ignoró.

VER TAMBIÉN:
    oxidegate-mcp    elige qué servidores MCP se preservan al arrancar
`;

/**
 * Recoge las observaciones y deja que `lib/mcp-doctor.mjs` juzgue. Cada
 * comprobación que hace es un fallo que mordió de verdad durante el
 * desarrollo y que no era diagnosticable desde fuera — el peor, un /health
 * en 404 que hacía caer todo el enrutado a directo EN SILENCIO.
 */
/**
 * Sondeo TOLERANTE, que nunca lanza.
 *
 * `getJson` lanza a propósito y el manejador de arriba imprime y sale — bien
 * para el reporte, fatal aquí: el doctor moría antes de diagnosticar
 * exactamente en los dos casos para los que existe (un okupa en el puerto y
 * un proxy caído). Un diagnóstico que se muere con el paciente no sirve.
 */
async function probeRequests(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/requests`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // Contestó algo: es alcanzable, sea o no OxideGate. Esa distinción es
    // justo la que el diagnóstico necesita mantener separada.
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.includes('json')) return { reachable: true, rows: null };
    const body = await res.json().catch(() => null);
    return { reachable: true, rows: Array.isArray(body) ? body : null };
  } catch {
    return { reachable: false, rows: null };
  }
}

async function runDoctor(baseUrl) {
  const { reachable, rows: requests } = await probeRequests(baseUrl);
  const isOxidegate = Array.isArray(requests);

  let healthCode = null;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    healthCode = res.status;
  } catch {
    // Queda en null: es una comprobación que NO se pudo hacer, no un fallo
    // de la ruta. El módulo lo traduce a 'unknown', nunca a 'ok'.
  }

  // El proyecto se lee UNA vez y se pasa a los dos lectores: así no se lee
  // el fichero dos veces ni se duplica la lógica de confianza.
  const projectConfig = readProjectConfig({ cwd: process.cwd(), approvals: readApprovals({}) });

  const rows = isOxidegate ? requests : [];
  const withTools = rows.filter((r) => r && r.context_tools_bytes > 0);

  const { checks, verdict } = diagnose({
    baseUrl,
    reachable,
    isOxidegate,
    healthCode,
    requestCount: isOxidegate ? rows.length : null,
    flattened: withTools.some((r) => r.tools_flattened === true),
    snapshot: readMcpSavingsSnapshot({}),
    protection: readProtectedServers({ projectConfig }),
    // La copia que OpenCode se guarda del plugin. Se recoge SIEMPRE: es un
    // eslabón que se queda viejo sin avisar, y ya costó una tarde entera.
    opencodeCache: diagnoseCache({
      cached: readCachedPluginVersion({}),
      running: LENS_VERSION,
    }),
    switchResult: readDisableByDefault({ projectConfig }),
    projectConfig,
  });

  const MARK = { ok: '✔', warn: '!', fail: '✖', unknown: '?' };
  process.stdout.write('\noxidegate-lens — diagnóstico de la cadena\n\n');
  for (const c of checks) {
    process.stdout.write(`  ${MARK[c.status] ?? '?'} ${c.title}\n`);
    if (c.detail) process.stdout.write(`      ${c.detail}\n`);
    if (c.action) process.stdout.write(`      → ${c.action}\n`);
    process.stdout.write('\n');
  }
  const RESUMEN = {
    ok: 'Todo comprobado y en orden.',
    degraded: 'Funciona, pero hay algo que limita lo que se puede reportar.',
    unknown: 'Algo no se pudo comprobar. No se declara nada sobre lo que no se miró.',
    broken: 'Hay al menos un eslabón roto. Empieza por el primer ✖ de arriba.',
  };
  process.stdout.write(`  ${verdict.toUpperCase()} — ${RESUMEN[verdict]}\n\n`);
  process.exitCode = verdict === 'broken' ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  if (args.includes('--clear-opencode-cache')) {
    clearOpenCodeCache();
    return;
  }

  const found = await discoverEndpoint();
  const baseUrl = found.baseUrl;
  announceOverride(found);

  if (args.includes('--doctor')) {
    await runDoctor(baseUrl);
    return;
  }

  const [requests, stats] = await Promise.all([
    getJson(baseUrl, '/requests'),
    getJson(baseUrl, '/stats'),
  ]);

  if (!Array.isArray(requests) || requests.length === 0) {
    // Nombrar el endpoint no es adorno. Esta frase describía dos situaciones
    // incompatibles —el proxy correcto sin tráfico, y un okupa en el puerto
    // contestando cualquier cosa— y la segunda tuvo la herramienta rota
    // durante meses. Ahora que la lente busca el proxy sola, el usuario ya no
    // sabe de memoria a quién preguntó: hay que decírselo.
    process.stderr.write(
      `oxidegate-lens: ${baseUrl} es OxideGate, pero no ha visto ninguna petición todavía.\n` +
        `  Enruta tu agente a través del proxy y vuelve a pedir el reporte. ` +
        `Con --doctor tienes la cadena entera.\n`,
    );
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

  // (d) valve informado MCP: computado acá (necesita el arreglo COMPLETO de
  // `requests`, no sólo `entry`, para derivar la ventana de observación) y
  // renderizado al final de main(), después de las secciones (a)/(b)/(c)
  // existentes — ver el header del módulo escrito para esta sección.
  const snapshot = readMcpSavingsSnapshot();
  const usage = observeMcpUsage(requests);
  const valve = buildValveRows({ snapshot, usage });

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

  writeRequestDashboard(entry);

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
        `Este reporte no usa \`deferred_tools\` para decidir ahorro en tráfico ${entry.upstream}:\n` +
          'la tabla de bytes sólo dice qué filas MCP llegaron en esta petición. No concluye si el\n' +
          'harness cargó herramientas de forma diferida o inmediata.\n',
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

  // ---------------------------------------------------------------------
  // (d) VALVE INFORMADO MCP — cuarta sección independiente, impresa después
  // de (a)/(b)/(c) y del caveat de arriba, nunca mezclada con ellas.
  // ---------------------------------------------------------------------
  writeMcpValveSection({ snapshot, usage, valve });
}

try {
  await main();
} catch (err) {
  process.stderr.write(`oxidegate-lens: ${err?.message ?? 'unknown error'}\n`);
  process.exit(1);
}
