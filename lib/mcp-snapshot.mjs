// lib/mcp-snapshot.mjs
//
// CONTRACT
// --------
// Reads `~/.config/mcp-savings/snapshot.json` — the ONLY interface between
// this repo and mcp-savings. No `@mcp-savings/core` runtime import exists
// anywhere in this repo (`config.yaml` forbids it); this module reads the
// file mcp-savings writes and nothing else. All logic here is a PURE
// function of the bytes on disk plus an injected clock — no other I/O.
//
// Exports:
//   readMcpSavingsSnapshot({ path?, now? }) -> SnapshotResult
//   resolveSnapshotPath() -> string
//
// SnapshotResult is one of:
//   { status: 'known', freshness: 'fresh' | 'stale', timestamp, servers: [...] }
//   { status: 'unknown', reason: 'missing-file' | 'malformed-json' |
//                                  'unrecognized-shape' | 'unreadable' }
//
// Each entry in `servers[]`:
//   {
//     name: string,             // RAW mcpMeasurement[].server, unsanitized —
//                                // the join (lib/mcp-valve.mjs) owns
//                                // sanitizeServerName, not this module.
//     enabled: boolean|undefined,  // OPTIONAL passthrough; absent stays
//                                   // undefined, never coerced to a boolean.
//     tokens: number|null|undefined,  // OPTIONAL passthrough, VERBATIM.
//     price: { status: 'known', bytes: number }
//          | { status: 'unknown', reason: 'cannot-measure' | 'missing-bytes' },
//   }
//
// HONESTY INVARIANT — an absent measurement is never a zero measurement
// ------------------------------------------------------------------------
// Stated once here because it governs every branch below, verbatim from
// design.md Decision 4:
//
//   An absent measurement is never a zero measurement.
//
// This covers bytes AND tokens as ONE invariant, not two local rules.
//
// WHY THE GUARD TESTS `ok`, NOT `.bytes` PRESENCE
// -------------------------------------------------
// The next reader's instinct will be to check "is `.bytes` there?" — that
// instinct is WRONG for this field, and here is why: mcp-savings' own
// `measure.ts` builds `bytes` as the sum of a tool list. When a server's
// connect/list FAILS, that tool list is EMPTY, so `bytes` comes out
// PRESENT, TYPED, NUMERIC, and `0` — a real field holding a meaningless
// number. A field-presence check (`typeof entry.bytes === 'number'`) waves
// that fabricated `0` straight through as a genuine price. The `ok` flag is
// the ONLY field that can tell a real zero (`ok: true, bytes: 0` — a server
// with no tools, a KNOWN zero) apart from an unmeasurable one (`ok: false,
// bytes: 0` — mcp-savings could not measure this server at all). So the
// order of checks below is: test `ok === false` FIRST, discard `.bytes`
// entirely when it fires, and only fall through to reading `.bytes` when
// `ok` did not veto it. See test/mcp-snapshot.test.mjs's `ok:false` /
// `ok:true` pair — both carry `bytes: 0`; only the `ok` flag tells them
// apart, which is exactly the point of that pair.
//
// `tokens: null` is the same door on the other side (Claude models:
// `countTokens` returns `null`, meaning "no accurate tokenizer available",
// never "zero tokens"). This module passes `tokens` through UNCHANGED —
// `null` stays `null`, a number stays a number, an absent field stays
// `undefined`. It never substitutes `0` for any of them. Degrading the
// headline to bytes when tokens is absent is a RENDERING decision, owned by
// the caller (bin/oxidegate-savings.mjs section (d) / the plugin), not by
// this module.
//
// A missing REQUIRED field on one entry (`bytes`, when `ok` did not already
// veto it) drops THAT ENTRY's price only — `price: { status: 'unknown',
// reason: 'missing-bytes' }` — never the whole snapshot. An entry with no
// `server` field at all cannot be identified, so it is dropped from
// `servers[]` entirely; there is no row to attach a partial price to.
//
// DEFENSIVE PARSING NEVER THROWS
// --------------------------------
// A missing file, a syntax error, a torn/truncated write (mcp-savings'
// `saveSnapshot` is a bare `writeFileSync`, NOT atomic — see design.md
// "What the code already tells us"), or a value that parses as valid JSON
// but is not the expected shape (e.g. `null`, a bare number, an object with
// no `mcpMeasurement` array) all degrade to `{ status: 'unknown', reason }`.
// This module NEVER throws as a result of snapshot content — the read is
// wrapped so a torn file, however it tears, cannot crash the host plugin.
//
// STALENESS
// ---------
// `timestamp` is Unix epoch MILLISECONDS (verified against
// `mcp-savings/packages/core/src/types.ts:70`). Staleness is a plain
// `now - timestamp` comparison against a 24h threshold (spec: "Staleness
// labeling"), never date parsing. `now` is injected (default `Date.now()`)
// so tests never depend on the real clock.
//
// PATH RESOLUTION — AND WHY THE DUPLICATION IS DELIBERATE
// -----------------------------------------------------------
// `resolveSnapshotPath()` duplicates
// `mcp-savings/packages/core/src/config.ts::snapshotPath()` BY VALUE — the
// same `~/.config/mcp-savings/snapshot.json` layout, hand-copied, with NO
// import from the sibling repo. That duplication IS the file contract:
// importing the function would be exactly the runtime dependency on
// `@mcp-savings/core` that `config.yaml` forbids. It deliberately does NOT
// honour `XDG_CONFIG_HOME` — mcp-savings' own writer does not either, and
// matching the REAL writer matters more than matching a spec neither side
// follows. `OXIDEGATE_LENS_SNAPSHOT` overrides it, for hermetic tests and
// for users with a non-standard layout.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 24h — spec: "Staleness labeling". A snapshot older than this renders its
// price data labeled "stale", never as current, but STILL renders (stale
// price data is not dropped).
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function resolveSnapshotPath() {
  return process.env.OXIDEGATE_LENS_SNAPSHOT ?? join(homedir(), '.config', 'mcp-savings', 'snapshot.json');
}

/**
 * Reads a `mcpMeasurement[].bytes` figure as a price ONLY when `ok !== false`
 * — see "WHY THE GUARD TESTS `ok`, NOT `.bytes` PRESENCE" above. Never
 * throws; a malformed entry degrades to a per-entry `unknown` price.
 */
function priceForEntry(entry) {
  if (entry.ok === false) {
    return { status: 'unknown', reason: 'cannot-measure' };
  }
  if (typeof entry.bytes === 'number') {
    return { status: 'known', bytes: entry.bytes };
  }
  return { status: 'unknown', reason: 'missing-bytes' };
}

/**
 * Reads and defensively parses the mcp-savings snapshot at `path`
 * (default: `resolveSnapshotPath()`), comparing its `timestamp` against
 * `now` (default: `Date.now()`) for the 24h staleness label. Never throws —
 * see "DEFENSIVE PARSING NEVER THROWS" above.
 */
export function readMcpSavingsSnapshot({ path = resolveSnapshotPath(), now = Date.now() } = {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'unknown', reason: 'missing-file' };
    return { status: 'unknown', reason: 'unreadable' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unknown', reason: 'malformed-json' };
  }

  if (parsed === null || typeof parsed !== 'object' || typeof parsed.timestamp !== 'number') {
    return { status: 'unknown', reason: 'unrecognized-shape' };
  }

  const measurements = Array.isArray(parsed.mcpMeasurement) ? parsed.mcpMeasurement : [];

  const servers = [];
  for (const entry of measurements) {
    if (entry === null || typeof entry !== 'object' || typeof entry.server !== 'string') continue;
    servers.push({
      name: entry.server,
      enabled: entry.enabled,
      tokens: entry.tokens,
      price: priceForEntry(entry),
    });
  }

  const ageMs = now - parsed.timestamp;
  const freshness = ageMs > STALE_THRESHOLD_MS ? 'stale' : 'fresh';

  return { status: 'known', freshness, timestamp: parsed.timestamp, servers };
}
