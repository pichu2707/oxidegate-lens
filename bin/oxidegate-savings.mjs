#!/usr/bin/env node

// oxidegate-savings.mjs
//
// CONTRACT
// --------
// Answers one question: "how many bytes would I stop re-sending on every
// request if I disconnected each MCP server?"
//
// Reads (env):
//   OXIDEGATE_LENS_URL  - full base URL of the OxideGate proxy. Takes precedence.
//   OXIDEGATE_PORT      - used to build "http://127.0.0.1:<port>". Defaults to 8080.
//
// Reads (HTTP):
//   GET /requests  - the newest entry carrying a `tools_by_server` breakdown.
//   GET /stats     - how many requests that (upstream, model) has served, so we
//                    can report cumulative bytes actually re-sent on the wire.
//
// Writes (stdout): a table, then a summary line.
//
// WHAT THIS REPORTS, AND WHAT IT DOES NOT
// ---------------------------------------
// It reports BYTES, never tokens and never dollars. Every provider tokenises
// differently (Anthropic ~2.7 bytes/token on real traffic, llama ~4.1), so
// converting these bytes into tokens would need a per-model constant we do not
// have, and converting them into dollars would compound that guess with a
// pricing guess. A byte measured on the wire is a fact. A token inferred from
// it is not.
//
// Only rows with kind === "mcp" can be removed by disconnecting a server.
// The "(native)" row is the harness's own tool surface: `--strict-mcp-config`
// does not touch it. It can only be reduced with `--tools <list>`, which
// changes what the agent is able to DO, not merely what it carries.
//
// Failure policy: unlike the status line, this is a command a human runs on
// purpose. It explains failures on stderr and exits non-zero, so a broken
// setup is visible instead of silent.

const DEFAULT_PORT = 8080;

// This is an interactive CLI, not a status line. A human waiting two seconds
// for a localhost round trip is fine; a human staring at a blank terminal
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
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
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

  const toolsBytes = entry.context_tools_bytes ?? null;
  const seen = requestsSeen(stats, entry.upstream, entry.model);

  const rows = [...entry.tools_by_server].sort((a, b) => b.bytes - a.bytes);
  const removable = rows.filter((r) => r.kind === 'mcp');
  const removableBytes = removable.reduce((sum, r) => sum + r.bytes, 0);

  const share = (bytes) => (toolsBytes ? `${((bytes / toolsBytes) * 100).toFixed(1)}%` : '-');

  process.stdout.write(
    `fuente: ${entry.timestamp ?? '-'}  ${entry.model ?? '-'}  (${entry.upstream ?? '-'})\n\n`,
  );
  // Two trailing spaces after every right-aligned column: without them the
  // widest cell touches the next header and the table becomes unreadable.
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
  // Singular vs plural: "el servidor MCP" reads wrong as "los 1 servidores MCP".
  const n = removable.length;
  const serversPhrase = n === 1 ? 'el servidor MCP' : `los ${n} servidores MCP`;
  process.stdout.write(
    `ahorro por petición desconectando ${serversPhrase}: ` +
      `${humanizeBytes(removableBytes)}` +
      (toolsBytes ? ` (${share(removableBytes)} de los tools)` : '') +
      '\n',
  );

  if (seen) {
    const reqWord = seen === 1 ? 'petición observada' : 'peticiones observadas';
    process.stdout.write(
      `ya re-enviados en ${seen} ${reqWord}: ${humanizeBytes(removableBytes * seen)}\n`,
    );
  }

  process.stdout.write(
    '\nnota: son BYTES medidos en el cable, no tokens ni dólares. Cada proveedor\n' +
      'tokeniza distinto, así que convertirlos exigiría una constante que no se tiene.\n' +
      'Las filas `native` no se quitan desconectando nada: sólo con `--tools <lista>`,\n' +
      'que cambia lo que el agente PUEDE HACER, no sólo lo que carga.\n',
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`oxidegate-lens: ${err?.message ?? 'unknown error'}\n`);
  process.exit(1);
}
