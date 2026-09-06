#!/usr/bin/env node

// oxidegate-sessions.mjs
//
// CONTRACT
// --------
// The SECOND lens (issue #18). Where `oxidegate-savings` answers "what does
// THIS REQUEST cost in bytes", this one answers a different question, in a
// different currency: **what did THIS SESSION cost**. It reads `GET
// /sessions` — an aggregation by `(source, key)` — and renders it, exactly
// as read: it never measures anything itself, and it never merges its four
// blocks into one verdict. See `lib/session-report.mjs` for the honesty
// logic; this file owns discovery, the capabilities gate, the HTTP call,
// and rendering only.
//
// FOUR INDEPENDENT BLOCKS, printed one after another, never merged:
//
//   (a) SESIONES — rows where `is_session === true`, sorted by cost
//       descending. This is the report's real subject.
//
//   (b) NO ATRIBUIDO A UNA SESIÓN — rows where `is_session === false`. These
//       are per-client buckets (User-Agent), NOT sessions, and are NEVER
//       ranked or merged with (a). Their tokens are real and are shown;
//       their cost is marked "no atribuible" in the SAME line, never a bare
//       "0,0000 $" that reads as "this bucket cost nothing".
//
//   (c) EL PEAJE FIJO POR TURNO — `fixed_toll.{hooks,instructions,skills}`.
//       This is the reason this lens exists: a fixed per-turn payload (a
//       skill's system-prompt bytes, say) sent again on every turn it was
//       present in. `null` prints as "no medido", never as "0 B" — see
//       `lib/session-report.mjs`'s RULE 3.
//
//   (d) `saturated` — if the proxy's session registry filled up, the rows
//       above are a LOWER BOUND: some sessions/buckets never got a row of
//       their own. This is stated next to the totals it invalidates, not as
//       a footnote nobody reads.
//
// THE QUADRANT THAT LOOKS LIKE A BUG AND ISN'T
// ------------------------------------------------
// A real row measured against a live 0.13.0 proxy:
//
//   key: "unattributed"  input_tokens: 400919  cost_usd: 0.0
//
// The single biggest token consumer reports a cost of exactly zero. That is
// not a read failure and not "free" — it is `is_session: false`,
// `source: 'unattributed'`: the proxy could not pin this spend on a session
// at all. A report that ranked rows by cost, or printed that zero bare,
// would hand the reader a confidently wrong headline built from real
// numbers. See `lib/session-report.mjs`'s RULE 1 for the full argument, and
// its unit test for the row that breaks the naive correlation on purpose
// (`is_session: true` + `cost_usd: 0` — a real session, a real zero, still a
// session).
//
// THE CAPABILITIES GATE — publishesEndpoint is TRI-STATE, and the middle
// state is not a coin flip
// ------------------------------------------------------------------
//   true  -> the proxy told us it publishes `/sessions`. Proceed.
//   false -> the proxy told us it does NOT. Say so and updates, and STOP —
//            never render an empty table for a proxy that never had the
//            endpoint to begin with.
//   null  -> we could not ask (`/version` unreachable, timed out, or this
//            proxy predates the capabilities contract). This is NOT `false`
//            in disguise — it means "no answer", not "no". Try the actual
//            request anyway, and only degrade to the "update your
//            OxideGate" message if THAT comes back 404 — a fact the proxy
//            just told us, not a guess this lens made on its behalf.
//
// `--since` — same contract as `/stats`'s `?since=`: a date (`YYYY-MM-DD`)
// or a day count (`7d`). Passed straight through to the proxy, which
// validates it and answers 400 with a message in Spanish that is already
// good — this lens relays that message verbatim rather than writing its
// own. Without `--since`, the header says the window covers everything the
// proxy still retains; this lens has no idea what that retention window is,
// and does not pretend to.

import { humanizeBytes } from '../lib/format.mjs';
import { buildSessionReport } from '../lib/session-report.mjs';
import { readProxyVersion, publishesEndpoint } from '../lib/proxy-version.mjs';
import { buildEndpointCandidates, chooseEndpoint, readProxyLogUrl } from '../lib/mcp-endpoint.mjs';

const DEFAULT_PORT = 8080;

// Interactive command a human runs on purpose — same budget as
// bin/oxidegate-savings.mjs, for the same reason: a blank terminal because
// we gave up after 300ms on a localhost round trip is worse than waiting.
const FETCH_TIMEOUT_MS = 2000;

const SOURCE_LABEL = {
  'proxy-log': 'el propio proxy dice estar escuchando',
  'known-port': 'estaba escuchando',
  'env-port': 'apunta OXIDEGATE_PORT',
  'env-url': 'apunta OXIDEGATE_LENS_URL',
};

/**
 * Sondeo TOLERANTE de identidad, igual que `probeRequests` en
 * bin/oxidegate-savings.mjs: nunca lanza, sólo dice si hay alguien
 * escuchando y si ese alguien es OxideGate de verdad.
 */
async function probeRequests(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/requests`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.includes('json')) return { reachable: true, rows: null };
    const body = await res.json().catch(() => null);
    return { reachable: true, rows: Array.isArray(body) ? body : null };
  } catch {
    return { reachable: false, rows: null };
  }
}

/** Igual que en bin/oxidegate-savings.mjs — ver ese header para el porqué de cada regla. */
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

  const baseUrl = found.status === 'found' ? found.baseUrl : (candidates[0]?.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}`);
  return { ...found, baseUrl };
}

function announceOverride(found) {
  if (!found.overrode) return;
  process.stderr.write(
    `oxidegate-lens: ${found.overrode.baseUrl} responde, pero no es OxideGate — ` +
      `se ignora ${found.overrode.source === 'env-port' ? 'OXIDEGATE_PORT' : 'la URL configurada'}.\n` +
      `  Usando ${found.baseUrl}, que es donde ${SOURCE_LABEL[found.source] ?? 'se encontró el proxy'}.\n`,
  );
}

// ---------------------------------------------------------------------
// Formato — números específicos de este informe. `humanizeBytes` viene de
// lib/format.mjs (compartido con oxidegate-savings); coste y enteros con
// separador de miles son propios de este informe, que no existían allí.
// ---------------------------------------------------------------------

/** `0.883174` -> `"0.8832 $"`. Nunca se llama con `null` — los callers ya lo comprueban. */
function formatUsd(value) {
  return `${value.toFixed(4)} $`;
}

/**
 * `6839` -> `"6.839"` (separador de miles en punto, convención `es-ES`).
 * `useGrouping: 'always'` a propósito: sin él, `Intl` con datos ICU
 * reducidos (el Node de este proyecto no trae `full-icu`) no agrupa números
 * de cuatro cifras por debajo de 10.000 (`6839` sale como `"6839"`), sólo a
 * partir de cinco — comprobado en este mismo runtime, no asumido de la spec.
 */
function formatInt(value) {
  return value.toLocaleString('es-ES', { useGrouping: 'always' });
}

/** Clave truncada legible. `null` — nunca inventa un string — se marca explícitamente. */
function truncateKey(key, maxLen = 28) {
  if (key === null) return '(clave desconocida)';
  if (key.length <= maxLen) return key;
  return `${key.slice(0, maxLen - 1)}…`;
}

function pad(value, width, align = 'left') {
  const text = String(value);
  if (text.length >= width) return text;
  const filler = ' '.repeat(width - text.length);
  return align === 'right' ? filler + text : text + filler;
}

/**
 * Línea de un total. Semántica `sumOrUnknown`: un campo `null` se imprime
 * como "desconocido", nunca como una suma parcial disfrazada de completa.
 * `costNote`, si se pasa, se añade EN LA MISMA línea que la cifra de coste —
 * nunca en un párrafo aparte (issue #18, regla 2).
 */
function formatTotalLine(label, totals, { saturated, costNote } = {}) {
  const satTag = saturated ? ' [cota inferior — registro saturado, ver aviso arriba]' : '';
  const costText =
    totals.cost === null ? 'desconocido' : `${formatUsd(totals.cost)}${costNote ? ` (${costNote})` : ''}`;
  const parts = [
    `coste=${costText}`,
    `turnos=${totals.requests === null ? 'desconocido' : formatInt(totals.requests)}`,
    `entrada=${totals.inputTokens === null ? 'desconocido' : formatInt(totals.inputTokens)}`,
    `cache_leída=${totals.cacheReadTokens === null ? 'desconocido' : formatInt(totals.cacheReadTokens)}`,
    `salida=${totals.outputTokens === null ? 'desconocido' : formatInt(totals.outputTokens)}`,
  ];
  const filaWord = totals.count === 1 ? 'fila' : 'filas';
  return `  total ${label} (${totals.count} ${filaWord}): ${parts.join('  ')}${satTag}\n`;
}

// ---------------------------------------------------------------------
// (a) SESIONES
// ---------------------------------------------------------------------
function writeSessionsBlock(report) {
  process.stdout.write('\nSESIONES (coste real, atribuible a una sesión de trabajo):\n');
  if (report.sessions.length === 0) {
    process.stdout.write('  no hay sesiones registradas en esta ventana.\n');
    return;
  }

  process.stdout.write(
    `  ${pad('CLAVE', 28)}  ${pad('TURNOS', 6, 'right')}  ${pad('COSTE', 12, 'right')}  ` +
      `${pad('ENTRADA', 10, 'right')}  ${pad('CACHE_LEÍDA', 12, 'right')}  ${pad('SALIDA', 10, 'right')}\n`,
  );
  for (const row of report.sessions) {
    process.stdout.write(
      `  ${pad(truncateKey(row.key), 28)}  ` +
        `${pad(row.requests === null ? '-' : formatInt(row.requests), 6, 'right')}  ` +
        `${pad(row.costUsd === null ? 'desconocido' : formatUsd(row.costUsd), 12, 'right')}  ` +
        `${pad(row.inputTokens === null ? '-' : formatInt(row.inputTokens), 10, 'right')}  ` +
        `${pad(row.cacheReadTokens === null ? '-' : formatInt(row.cacheReadTokens), 12, 'right')}  ` +
        `${pad(row.outputTokens === null ? '-' : formatInt(row.outputTokens), 10, 'right')}\n`,
    );
  }
}

// ---------------------------------------------------------------------
// (b) NO ATRIBUIDO A UNA SESIÓN
// ---------------------------------------------------------------------
function writeUnattributedBlock(report) {
  process.stdout.write(
    '\nNO ATRIBUIDO A UNA SESIÓN (cubos por cliente/user-agent — NUNCA rankeados junto a las sesiones de arriba):\n',
  );
  if (report.unattributed.length === 0) {
    process.stdout.write('  no hay filas no atribuidas en esta ventana.\n');
    return;
  }

  for (const row of report.unattributed) {
    const costText =
      row.costUsd === null
        ? 'desconocido'
        : `${formatUsd(row.costUsd)} (no atribuible — is_session:false, no es el coste de una sesión)`;
    process.stdout.write(
      `  - ${truncateKey(row.key)}  turnos=${row.requests === null ? '-' : formatInt(row.requests)}  ` +
        `entrada=${row.inputTokens === null ? '-' : formatInt(row.inputTokens)}  ` +
        `cache_leída=${row.cacheReadTokens === null ? '-' : formatInt(row.cacheReadTokens)}  ` +
        `salida=${row.outputTokens === null ? '-' : formatInt(row.outputTokens)}  coste=${costText}\n`,
    );
  }
}

// ---------------------------------------------------------------------
// (c) EL PEAJE FIJO POR TURNO
// ---------------------------------------------------------------------
function formatTollMember(name, member) {
  if (member.status === 'unmeasured') return `      ${name}: no medido\n`;
  if (member.product === null) {
    return (
      `      ${name}: ${formatInt(member.bytes)} B, visto en ${formatInt(member.seenIn)} turno(s) — ` +
      'turnos totales desconocidos, no se calcula el repetido\n'
    );
  }
  return (
    `      ${name}: ${formatInt(member.bytes)} B × ${formatInt(member.seenIn)} turnos ≈ ` +
    `${humanizeBytes(member.product)} repetidos\n`
  );
}

function writeFixedTollBlock(report) {
  process.stdout.write(
    '\nEL PEAJE FIJO POR TURNO (fixed_toll — un payload que se repite en cada turno donde estuvo):\n',
  );
  if (report.fixedToll.length === 0) {
    process.stdout.write('  no hay filas en esta ventana: nada que medir de peaje fijo.\n');
    return;
  }
  for (const row of report.fixedToll) {
    const claseTexto = row.isSession === true ? 'sesión' : row.isSession === false ? 'no-sesión' : 'sin clasificar';
    process.stdout.write(`  - ${truncateKey(row.key)} (${claseTexto}):\n`);
    process.stdout.write(formatTollMember('hooks', row.members.hooks));
    process.stdout.write(formatTollMember('instructions', row.members.instructions));
    process.stdout.write(formatTollMember('skills', row.members.skills));
  }
}

// ---------------------------------------------------------------------
// (d) saturated
// ---------------------------------------------------------------------
function writeSaturatedNotice(report) {
  if (!report.saturated) return;
  process.stdout.write(
    '\naviso: este registro está SATURADO — el proxy dejó de admitir claves nuevas cuando se llenó.\n' +
      'Las filas de arriba son una COTA INFERIOR: hay sesiones y/o cubos que no llegaron a tener fila\n' +
      'propia. Ningún total de abajo se puede leer como una suma completa.\n',
  );
}

const HELP = `oxidegate-sessions — qué costó cada SESIÓN, no cada petición

USO:
    oxidegate-sessions                  El reporte completo
    oxidegate-sessions --since FECHA    Sólo la ventana desde FECHA
    oxidegate-sessions --help           Muestra esta ayuda

--since:
    Mismo contrato que /stats: una fecha YYYY-MM-DD o un número de días
    como "7d". Se manda tal cual al proxy, que lo valida — si no lo
    entiende, este comando imprime el mensaje que da el proxy y sale con
    código distinto de 0. Sin --since, la ventana es todo lo que el
    proxy retenga (no hay forma de saber cuánto es eso desde aquí).

QUÉ RESPONDE:
    Cuánto costó cada sesión de trabajo — no cada petición ni cada
    modelo. Cuatro bloques independientes, nunca un solo veredicto:
    sesiones (coste real), lo no atribuido a ninguna sesión (cubos por
    cliente, nunca rankeados junto a las sesiones), el peaje fijo por
    turno (hooks/instructions/skills repetidos turno a turno), y un
    aviso si el registro del proxy se saturó.

QUÉ NO PUEDE DECIR:
    No mide el crecimiento turno a turno dentro de una sesión — eso
    necesita /requests, no /sessions (ver issue #31). Tampoco decide si
    un coste "no atribuible" es un problema: sólo lo separa y lo marca.

DÓNDE MIRA:
    Igual que oxidegate-savings: OXIDEGATE_LENS_URL, si no
    OXIDEGATE_PORT, si no ~/.config/oxidegate/proxy.log, si no los
    puertos habituales (8080, 8899). Comprueba siempre que quien
    contesta es OxideGate de verdad antes de creerle.

VER TAMBIÉN:
    oxidegate-savings    bytes por servidor MCP en cada petición
`;

function readSinceArg(args) {
  const withEquals = args.find((a) => a.startsWith('--since='));
  if (withEquals) return withEquals.slice('--since='.length);
  const idx = args.indexOf('--since');
  if (idx !== -1 && typeof args[idx + 1] === 'string') return args[idx + 1];
  return null;
}

/**
 * Trae `/sessions`, tolerante: NUNCA lanza. Cada rama de fallo se cuenta a
 * `main()` con un `status` propio, en vez de un `throw` genérico, porque
 * cada una tiene un mensaje y una acción distintos — igual que
 * `readProxyVersion` en lib/proxy-version.mjs.
 */
async function fetchSessions(baseUrl, since) {
  const url = new URL('/sessions', baseUrl);
  if (since !== null) url.searchParams.set('since', since);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { status: 'unreachable', message: err?.message ?? 'error de red' };
  }

  if (res.status === 400) {
    const text = await res.text().catch(() => '');
    return { status: 'bad-since', message: text.trim() };
  }
  if (res.status === 404) {
    return { status: 'not-found' };
  }
  if (!res.ok) {
    return { status: 'http-error', code: res.status };
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    return { status: 'not-json' };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 'unparseable' };
  }
  return { status: 'ok', body };
}

const NO_PUBLICA_MSG = 'oxidegate-lens: tu OxideGate no publica /sessions, actualiza.\n';

async function main() {
  // Cortar la salida con `| head` cierra stdout antes de terminar de
  // escribir — ver bin/oxidegate-mcp.mjs para el mismo guardia.
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    throw error;
  });

  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const since = readSinceArg(args);

  const found = await discoverEndpoint();
  const baseUrl = found.baseUrl;
  announceOverride(found);

  // La puerta de capacidades: tri-estado, ver header del módulo.
  const version = await readProxyVersion({ baseUrl, timeoutMs: FETCH_TIMEOUT_MS });
  const publishes = publishesEndpoint(version, '/sessions');

  if (publishes === false) {
    process.stderr.write(NO_PUBLICA_MSG);
    process.exit(1);
  }

  const fetched = await fetchSessions(baseUrl, since);

  if (fetched.status === 'not-found') {
    // `publishes` era `true` o `null` — en cualquier caso, el proxy acaba de
    // responder 404 de verdad. Es la MISMA frase que la rama `false` de
    // arriba: para quien lee el mensaje, la causa no importa, la acción sí.
    process.stderr.write(NO_PUBLICA_MSG);
    process.exit(1);
  }
  if (fetched.status === 'bad-since') {
    process.stderr.write(`oxidegate-lens: ${fetched.message || 'el valor de --since no es válido'}\n`);
    process.exit(1);
  }
  if (fetched.status === 'unreachable') {
    process.stderr.write(`oxidegate-lens: no se pudo conectar con ${baseUrl}: ${fetched.message}\n`);
    process.exit(1);
  }
  if (fetched.status === 'not-json' || fetched.status === 'unparseable') {
    process.stderr.write(`oxidegate-lens: ${baseUrl} respondió, pero /sessions no devolvió JSON entendible.\n`);
    process.exit(1);
  }
  if (fetched.status === 'http-error') {
    process.stderr.write(`oxidegate-lens: GET /sessions devolvió ${fetched.code}.\n`);
    process.exit(1);
  }

  const report = buildSessionReport(fetched.body);
  if (report.status !== 'known') {
    process.stderr.write('oxidegate-lens: /sessions respondió, pero con una forma que esta versión no reconoce.\n');
    process.exit(1);
  }

  process.stdout.write(
    `fuente: ${baseUrl}/sessions\n` +
      `ventana: ${since ? `desde ${since}` : 'todo lo que el proxy retiene (sin --since)'}\n`,
  );

  writeSessionsBlock(report);
  writeUnattributedBlock(report);
  writeFixedTollBlock(report);
  writeSaturatedNotice(report);

  process.stdout.write('\nTOTALES:\n');
  process.stdout.write(
    formatTotalLine('sesiones', report.totals.sessions, { saturated: report.saturated }),
  );
  process.stdout.write(
    formatTotalLine('no atribuido', report.totals.unattributed, {
      saturated: report.saturated,
      costNote: 'no atribuible',
    }),
  );

  process.stdout.write(
    '\nnota: no mide crecimiento turno a turno dentro de una sesión — eso necesita /requests,\n' +
      'no /sessions (issue #31). "no atribuible" no es un juicio: sólo separa lo que el proxy\n' +
      'no pudo pinchar en una sesión concreta.\n',
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`oxidegate-lens: ${err?.message ?? 'unknown error'}\n`);
  process.exit(1);
}
