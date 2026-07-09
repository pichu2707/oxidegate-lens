#!/usr/bin/env node

// oxidegate-status.mjs
//
// CONTRACT
// --------
// Reads (stdin): the Claude Code status-line JSON payload documented at
//   https://code.claude.com/docs/en/statusline
// This script does not require any specific field from it — it only cares
// that stdin might be EMPTY or not valid JSON, and must not crash either way.
//
// Reads (env):
//   OXIDEGATE_LENS_URL  - full base URL of the OxideGate proxy, e.g.
//                         "http://127.0.0.1:8899". Takes precedence.
//   OXIDEGATE_PORT      - used to build "http://127.0.0.1:<port>" when
//                         OXIDEGATE_LENS_URL is not set. Defaults to 8080.
//
// Writes (stdout): at most ONE line of plain text summarising the newest
// entry in GET /requests that has a non-null context_measured_bytes.
// Example: "oxidegate  claude-opus-4-8  tax 89.5%  tools 159.1 kB  ttft 3.0s  $0.2464"
//
// Failure policy: this script is invoked by the Claude Code status line,
// which has NO documented timeout for the command. A hung or noisy status
// line is worse than a missing one, so ANY failure (network error, non-2xx,
// timeout, empty/malformed JSON, no usable entry) results in printing
// NOTHING and exiting 0. Nothing here is allowed to throw uncaught or print
// to stderr.

const DEFAULT_PORT = 8080;

// The status line refreshes roughly every 5s (refreshInterval). This
// request must be a small fraction of that budget so it never becomes
// perceptible as a stall, so it gets 300ms — generous for a localhost
// round trip, tiny compared to the 5s refresh cadence.
const FETCH_TIMEOUT_MS = 300;

function resolveBaseUrl() {
  if (process.env.OXIDEGATE_LENS_URL) return process.env.OXIDEGATE_LENS_URL;
  const port = process.env.OXIDEGATE_PORT ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Decimal (base 1000) byte humaniser, mirroring OxideGate's `format_bytes`.
// Below 1000 bytes we print the exact count: rendering 77 B as "0.1 kB" turns
// a real number into noise. Above that, the unit is chosen AFTER rounding, so
// 999,950 B renders as "1.0 MB" and never as "1000.0 kB".
function humanizeBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes < 1000) return `${bytes} B`;
  const kb = Math.round((bytes / 1000) * 10) / 10;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  const mb = Math.round((bytes / 1_000_000) * 10) / 10;
  return `${mb.toFixed(1)} MB`;
}

// Every "missing" convention below follows OxideGate's own rule: an honest
// gap (shown as "-") beats a false zero. Never coerce null/undefined to 0.
function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '-';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatSeconds(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd) {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '-';
  return `$${usd.toFixed(4)}`;
}

function formatModel(model) {
  return model === null || model === undefined || model === '' ? '-' : model;
}

async function main() {
  // stdin payload is parsed but currently unused beyond the contract check
  // that it never crashes this script.
  const raw = await readStdin();
  try {
    raw ? JSON.parse(raw) : {};
  } catch {
    // Malformed stdin is not fatal — proceed with an empty payload.
  }

  const baseUrl = resolveBaseUrl();
  const res = await fetch(`${baseUrl}/requests`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return;

  const requests = await res.json();
  if (!Array.isArray(requests) || requests.length === 0) return;

  // Oldest first per OxideGate's contract, so scan from the end for the
  // newest entry that actually has a measured context size.
  const entry = [...requests]
    .reverse()
    .find((r) => r && r.context_measured_bytes !== null && r.context_measured_bytes !== undefined);
  if (!entry) return;

  const line = [
    'oxidegate',
    formatModel(entry.model),
    `tax ${formatPercent(entry.context_tax_ratio)}`,
    `tools ${humanizeBytes(entry.context_tools_bytes)}`,
    `ttft ${formatSeconds(entry.ttft_ms)}`,
    formatCost(entry.cost_estimate_usd),
  ].join('  ');

  process.stdout.write(`${line}\n`);
}

try {
  await main();
} catch {
  // Silent by design — see failure policy above.
}
process.exit(0);
