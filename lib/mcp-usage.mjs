// lib/mcp-usage.mjs
//
// CONTRACT
// --------
// Derives an MCP usage OBSERVATION from OxideGate's `GET /requests` ring
// buffer (`RecentRequest[]`, oldest-first, `RECENT_CAPACITY = 200`) — never
// from a wall clock, never from an assumed proxy uptime. All logic here is a
// PURE function of the request array handed to it; this module performs no
// I/O, and does not know a snapshot file exists (that is `lib/mcp-snapshot.mjs`'s
// concern, joined against this module's output one layer up in
// `lib/mcp-valve.mjs`).
//
// Exports:
//   observeMcpUsage(requests, { now? }) -> UsageResult
//
// UsageResult is one of:
//   { status: 'observed', windowMs, usesByLabel, hasOthersBucket }
//   { status: 'insufficient-observation', windowMs, count }
//
// `usesByLabel` is a plain object keyed by the SANITIZED wire label
// (`tools_by_server[].server`, `kind: 'mcp'`), counting how many requests in
// the window declared that server's tools at least once. `hasOthersBucket`
// is a WINDOW-LEVEL flag: true if ANY row in the window carries a
// `kind: 'others'` overflow entry (see "OVERFLOW" below).
//
// THE WINDOW IS DERIVED, NEVER ASSUMED (design.md Decision 2)
// -------------------------------------------------------------
// `windowMs = newest.timestamp - oldest.timestamp`, computed ONLY across
// rows whose `tools_by_server` is an ARRAY (empty or not) and whose
// `timestamp` parses as a valid RFC 3339 string. This is a fact derivable
// from the payload alone — it needs no assumption about how long OxideGate
// has been running and no clock agreement between two processes. A fixed
// wall-clock window ("last 3h") was considered and rejected: lens cannot
// verify the proxy was actually up and observing for that whole span, and
// asserting it anyway is exactly the kind of statement-about-the-world this
// repo's review history exists to remove from a presentation layer.
//
// `now` is accepted in the signature for parity with this repo's other
// injected-clock modules (`lib/mcp-snapshot.mjs`) and so tests never depend
// on the real clock for ANY call into this module. It is NOT read internally
// for window arithmetic — doing so would reintroduce the exact
// clock-agreement assumption Decision 2 rejects. The window is always
// `newest - oldest` from the payload's own timestamps, nothing else.
//
// ROWS EXCLUDED FROM THE WINDOW
// -------------------------------
// A row whose `tools_by_server` is absent or not an array (an OxideGate
// build predating the field) is NOT evidence of absence — it cannot
// distinguish "no MCP traffic happened" from "this build does not report
// it". Such rows are dropped entirely, mirroring the `CTX_UNKNOWN`
// discipline in `bin/oxidegate-savings.mjs`. A row with an EMPTY
// `tools_by_server` array IS included: it is a real observation that a
// request declared no tools. A row whose `timestamp` does not parse as a
// valid RFC 3339 string is also dropped — not fatal, just excluded from the
// evidence — since this module MUST NEVER throw as a result of payload
// content (defensive parsing, same discipline as `lib/mcp-snapshot.mjs`).
//
// THE TWO-PART SUFFICIENCY GATE, AND THE HONESTY INVARIANT IT ENFORCES
// ------------------------------------------------------------------------
// An absent measurement is never a zero measurement (design.md Decision 4)
// applies here in its OBSERVATIONAL form: a SAMPLE TOO THIN TO JUDGE IS
// NEVER REPORTED AS "0 uses". `observeMcpUsage` refuses to return
// `status: 'observed'` — and therefore refuses to let a caller build any
// recommendation — unless BOTH gates below hold. They fail in ORTHOGONAL
// directions, so neither alone is sufficient:
//
//   - MIN_WINDOW_MS  : kills the BURST case — 200 requests fired in 90
//                       seconds is plenty of DATA but no TIME observed. A
//                       server used hourly would read as unused.
//   - MIN_REQUEST_COUNT : kills the IDLE case — a proxy up for four hours
//                          that saw two requests is plenty of TIME but no
//                          EVIDENCE.
//
// Under `insufficient-observation`, the caller states what WAS observed
// (windowMs, count) and stops — "not enough to judge yet" is a first-class
// output, not a degraded/blank one, and NO server may be recommended for
// anything on the strength of that observation. That is the concrete
// mechanism that stops a freshly-started OxideGate from recommending
// disabling every MCP server on the fleet.
//
// MIN_WINDOW_MS AND MIN_REQUEST_COUNT ARE JUDGMENT CALLS, NOT MEASURED
// THRESHOLDS — see the constants below for the full statement. A future
// change may retune them; the reasoning above is what a change should argue
// with, not the numbers themselves.

// JUDGMENT CALL, NOT A MEASURED THRESHOLD. 30 minutes is the point past
// which "this server had 0 uses" starts to carry real information rather
// than reading as "the proxy just wasn't running long enough to see one".
// design.md's open-questions section states this explicitly: the SHAPE of
// the gate (two orthogonal conditions) is the fixed part of this design; the
// numbers are a task-time call, deliberately expressed as a named constant
// so a future change can retune them without re-deriving the reasoning.
const MIN_WINDOW_MS = 30 * 60 * 1000;

// JUDGMENT CALL, NOT A MEASURED THRESHOLD. 5 requests is the point past
// which "0 uses" is not plausibly an artifact of having observed almost
// nothing. Same status as MIN_WINDOW_MS above: a task-time call, not an
// empirically derived cutoff, kept as a named constant for exactly that
// reason.
const MIN_REQUEST_COUNT = 5;

/**
 * Parses a row's `timestamp` (RFC 3339 string) into epoch milliseconds, or
 * `null` if it does not parse — never throws.
 */
function parseRowTimestamp(row) {
  const parsed = Date.parse(row?.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Filters `requests` down to rows that count as evidence for the window:
 * `tools_by_server` present as an array (empty or not) AND a parseable
 * `timestamp`. See "ROWS EXCLUDED FROM THE WINDOW" above.
 */
function selectValidRows(requests) {
  const rows = Array.isArray(requests) ? requests : [];
  const valid = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (!Array.isArray(row.tools_by_server)) continue;
    const timestampMs = parseRowTimestamp(row);
    if (timestampMs === null) continue;
    valid.push({ row, timestampMs });
  }
  return valid;
}

/**
 * Observes MCP usage across `requests` (OxideGate's `GET /requests` ring
 * buffer). Never throws — see "ROWS EXCLUDED FROM THE WINDOW" above for how
 * malformed rows degrade instead of crashing. See the module header for the
 * full sufficiency-gate contract.
 */
export function observeMcpUsage(requests, { now } = {}) {
  void now; // accepted for signature parity only — see module header.

  const validRows = selectValidRows(requests);
  const count = validRows.length;

  let windowMs = 0;
  if (count > 0) {
    const timestamps = validRows.map((entry) => entry.timestampMs);
    windowMs = Math.max(...timestamps) - Math.min(...timestamps);
  }

  if (windowMs < MIN_WINDOW_MS || count < MIN_REQUEST_COUNT) {
    return { status: 'insufficient-observation', windowMs, count };
  }

  const usesByLabel = {};
  let hasOthersBucket = false;

  for (const { row } of validRows) {
    for (const entry of row.tools_by_server) {
      if (entry === null || typeof entry !== 'object') continue;
      if (entry.kind === 'others') {
        hasOthersBucket = true;
        continue;
      }
      if (entry.kind === 'mcp' && typeof entry.server === 'string') {
        usesByLabel[entry.server] = (usesByLabel[entry.server] ?? 0) + 1;
      }
    }
  }

  return { status: 'observed', windowMs, usesByLabel, hasOthersBucket };
}
