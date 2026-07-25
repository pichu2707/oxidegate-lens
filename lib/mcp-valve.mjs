// lib/mcp-valve.mjs
//
// CONTRACT
// --------
// Joins `lib/mcp-snapshot.mjs`'s price data against `lib/mcp-usage.mjs`'s
// wire observation, per MCP server, into `ValveRow[]` — the informed valve's
// entire recommendation logic. This module performs NO I/O, holds no
// `client`, and formats no string for a human; it is a PURE function of the
// two data shapes handed to it. See design.md's Decisions 5-8 for the full
// architectural reasoning; this header restates the two decisions a reader
// cannot reconstruct from the code alone.
//
// Exports:
//   buildValveRows({ snapshot, usage }) -> ValveResult
//
// `snapshot` is `readMcpSavingsSnapshot`'s return value (lib/mcp-snapshot.mjs);
// `usage` is `observeMcpUsage`'s return value (lib/mcp-usage.mjs). Both are
// taken as-is — this module trusts their shape, since both are already the
// OUTPUT of the two modules that do the defensive parsing.
//
// ValveResult:
//   {
//     rows: ValveRow[],
//     joinHealth: 'ok' | 'no-correspondence',
//     windowMs: number,   // usage.windowMs, verbatim, exposed here so a
//                          // caller never has to re-derive or separately
//                          // pass the window alongside the rows it belongs to
//     snapshotFreshness: 'fresh' | 'stale' | undefined,  // snapshot.freshness,
//                          // verbatim, when snapshot.status === 'known';
//                          // undefined when it is not (there is no snapshot,
//                          // so there is no freshness to report — never a
//                          // guessed 'stale')
//     snapshotTimestamp: number | undefined,  // snapshot.timestamp, verbatim,
//                          // under the same rule: present only alongside a
//                          // known snapshot, undefined otherwise
//   }
//
// WHY snapshotFreshness AND snapshotTimestamp ARE EXPOSED HERE (parity with windowMs)
// -----------------------------------------------------------------------------------
// A `candidate-to-disable` recommendation can be driven by a STALE price —
// this module has no opinion on staleness, it only joins whatever snapshot it
// is handed. That recommendation is only honest if the caller can SEE the
// price behind it was stale; a stale price silently producing a live-looking
// recommendation is exactly the kind of over-claim this whole change exists
// to prevent. `windowMs` already sets the precedent: it is threaded through
// `ValveResult` so a caller never has to separately carry the window
// alongside the rows it belongs to. `snapshotFreshness` and
// `snapshotTimestamp` get the same treatment, for the same reason — a caller
// that has to remember to thread a second variable alongside `rows` will
// eventually forget, and the day it forgets is the day a stale-priced
// recommendation renders with nothing beside it to flag the staleness.
// ValveRow:
//   {
//     label: string,              // the wire label this row is keyed by
//                                  // (matched rows: the wire label; snapshot-only
//                                  // and ambiguous rows: the raw snapshot name;
//                                  // unknown rows: the unattributed wire label)
//     join: 'exact' | 'sanitized' | 'snapshot-only' | 'unknown' | 'ambiguous',
//     snapshotNames: string[] | undefined,  // raw snapshot name(s) behind this
//                                            // row; undefined for 'unknown' rows,
//                                            // since no snapshot entry exists
//     price: { status: 'known', bytes: number }
//          | { status: 'unknown', reason: string }
//          | undefined,           // undefined ONLY for 'unknown' (wire-only) rows
//     enabled: boolean | undefined,
//     tokens: number | null | undefined,
//     uses: number | undefined,   // observed count in the window; undefined
//                                  // when unobservable (never a guessed 0)
//     recommendation: {
//       status: 'candidate-to-disable' | 'already-off' | 'no-recommendation',
//       reason: string | undefined,  // a NAMED constant on every refusal;
//                                     // undefined only for the two positive
//                                     // statuses, which need no reason
//     },
//   }
//
// DECISION 6 — THE MISMATCH/0-USES IDENTITY, AND WHY `unknown` EXISTS
// ---------------------------------------------------------------------
// Restated here verbatim from design.md, because neither is reconstructable
// from the code below:
//
//   These two statements select the SAME rows:
//     - "server X was measured but never appeared on the wire in this window"
//     - "server X's name in the snapshot does not correspond to its label
//        on the wire"
//   Both produce `join: 'snapshot-only'`. A per-row rule cannot tell them
//   apart — there is no third field to break the tie. So the disambiguation
//   is made at the FLEET level (`joinHealth`), not the row level.
//
//   `joinHealth` fires ('no-correspondence') only when the two instruments
//   agree about NOTHING: wire MCP traffic exists, but zero snapshot servers
//   matched any of it. That is the exact signature of a catastrophic naming
//   bug — the wire is busy while the snapshot names nothing on it. A real
//   "everything is unused" fleet does not look like that; it looks like
//   `wireMcpCount === 0`, which the sufficiency gate already handles.
//
//   A PARTIAL mismatch slips under that fleet-wide guard. The `unknown` row
//   closes that gap from the other side — not by attributing the spend
//   (there is no way to), but by REFUSING TO HIDE IT: wire spend that
//   matches no snapshot server MUST still render, as its own row, labeled
//   `unknown`, and MUST NEVER be dropped. A dropped row would be the worst
//   available outcome — it silently deletes evidence of real money spent,
//   and it deletes exactly the evidence that would have revealed the join
//   was broken. An `unknown` row carrying real spend is the tell-tale a
//   human can recognize where the code cannot resolve the ambiguity itself.
//
//   These two guards complement each other; neither replaces the other.
//   `joinHealth` catches total non-correspondence, fleet-wide. The `unknown`
//   row is what survives when the failure is partial and the fleet guard
//   stays silent. Two guards, two failure scales.
//
// THE COLLISION GUARD (Decision 5)
// -----------------------------------
// `sanitizeServerName` is NOT injective — distinct raw snapshot names can
// sanitize to the same wire label (`"foo bar"` and `"foo_bar"` both ->
// `"foo_bar"`). When that happens, NEITHER snapshot entry can claim the wire
// label with any confidence — there is no way to tell which one it belongs
// to. Both render `join: 'ambiguous'` and are ineligible for any
// recommendation (reason: 'name-collision'). This directly reuses
// `bin/oxidegate-savings.mjs`'s existing `declaredVsArrived` collision
// precedent — same lossy transform, same honest answer. Because a colliding
// group never claims its wire label, that label's own spend (if any) still
// surfaces separately as an `unknown` row — the collision does not excuse
// dropping the spend either.
//
// THE "NO SPEND AND NO PRICE" SILENCE RULE
// --------------------------------------------
// A `snapshot-only` row (no wire match at all) with an UNKNOWN price is not
// a finding — it is a server this module knows no cost for and saw no use
// of. Manufacturing a row that says nothing about it would be a nag, not
// information, so it is not emitted at all. This is narrower than "any
// unknown price": a MATCHED row (real observed spend, unknown price) still
// renders, because it has spend to report even without a price — silence
// requires BOTH conditions at once. `ambiguous` and `unknown` rows are never
// silenced this way either — the collision and the unattributed spend are
// each, by themselves, a finding worth surfacing.
//
// THE RECOMMENDATION CONJUNCTION (Decision 7)
// -----------------------------------------------
// `'candidate-to-disable'` requires EVERY one of these, checked in order,
// each failure returning its own NAMED reason (never a bare boolean, never a
// silent absence):
//
//   1. usage.status === 'observed'      else 'insufficient-observation'
//   2. joinHealth !== 'no-correspondence' else 'instruments-disagree'
//   3. !usage.hasOthersBucket            else 'not-individually-confirmed'
//   4. row.join !== 'ambiguous'          else 'name-collision'
//   5. row.join !== 'unknown'            else 'unattributed-spend'
//   6. row.price.status === 'known'      else 'price-unknown'
//   7. row.enabled !== false             else -> 'already-off' (a status,
//      not a refusal: the wire structurally cannot know a disabled
//      server's cost, so this branch renders the counterfactual instead)
//   8. row.uses === 0                    -> 'candidate-to-disable'
//      otherwise                        -> 'no-recommendation' / 'in-use'
//      (the server is priced, observed, and being used — nothing to report)
//
// DECISION 8 — THE TOPOLOGY FIREWALL
// ---------------------------------------
// This module imports ONLY `lib/mcp-snapshot.mjs`, `lib/mcp-usage.mjs`, and
// `sanitizeServerName` from `lib/mcp-config.mjs`. It exports data; it
// receives no `client`; no exported signature ever takes one. See
// test/mcp-valve-topology.test.mjs for the static (non-executing) proof that
// this module and its transitive imports contain no reference to the SDK's
// `client` object's `mcp` connect, disconnect, or status call sites.
// Recommendation data flows in exactly one direction: this module -> a
// caller's render step -> a human's eyes. There is no wire from here to the
// SDK, so no future edit can connect one without visibly creating a new
// import edge and defeating this comment.

import { sanitizeServerName } from './mcp-config.mjs';

// Named refusal reasons. Every branch below that declines to recommend
// states WHY, using one of these — never a bare boolean, never a silent
// absence. See "THE RECOMMENDATION CONJUNCTION" above for the gate each one
// corresponds to.
const REASON = {
  INSUFFICIENT_OBSERVATION: 'insufficient-observation',
  INSTRUMENTS_DISAGREE: 'instruments-disagree',
  NOT_INDIVIDUALLY_CONFIRMED: 'not-individually-confirmed',
  NAME_COLLISION: 'name-collision',
  UNATTRIBUTED_SPEND: 'unattributed-spend',
  PRICE_UNKNOWN: 'price-unknown',
  IN_USE: 'in-use',
};

/**
 * Tries to join a raw snapshot server name against the set of wire labels
 * actually observed in the window — tier 1 (exact identity) before tier 2
 * (sanitized). Returns `null` when neither tier matches; the caller treats
 * that as `snapshot-only`.
 */
function matchTier(rawName, wireLabelSet) {
  if (wireLabelSet.has(rawName)) return { join: 'exact', label: rawName };
  const sanitized = sanitizeServerName(rawName);
  if (wireLabelSet.has(sanitized)) return { join: 'sanitized', label: sanitized };
  return null;
}

/**
 * The recommendation conjunction (Decision 7). `joinHealth` is a fleet-level
 * fact computed once per `buildValveRows` call, not per row — see the
 * module header for why a per-row rule cannot carry this information alone.
 */
function recommendationFor(row, usage, joinHealth) {
  if (usage.status !== 'observed') {
    return { status: 'no-recommendation', reason: REASON.INSUFFICIENT_OBSERVATION };
  }
  if (joinHealth === 'no-correspondence') {
    return { status: 'no-recommendation', reason: REASON.INSTRUMENTS_DISAGREE };
  }
  if (usage.hasOthersBucket) {
    return { status: 'no-recommendation', reason: REASON.NOT_INDIVIDUALLY_CONFIRMED };
  }
  if (row.join === 'ambiguous') {
    return { status: 'no-recommendation', reason: REASON.NAME_COLLISION };
  }
  if (row.join === 'unknown') {
    return { status: 'no-recommendation', reason: REASON.UNATTRIBUTED_SPEND };
  }
  if (!row.price || row.price.status !== 'known') {
    return { status: 'no-recommendation', reason: REASON.PRICE_UNKNOWN };
  }
  if (row.enabled === false) {
    return { status: 'already-off' };
  }
  if (row.uses === 0) {
    return { status: 'candidate-to-disable' };
  }
  return { status: 'no-recommendation', reason: REASON.IN_USE };
}

/**
 * Joins a mcp-savings snapshot against an OxideGate usage observation into
 * `ValveRow[]` — a FULL OUTER JOIN, never an inner join (an inner join would
 * silently drop every priced-but-unused server, which is the entire
 * feature). See the module header for the collision guard, the `unknown`
 * row rule, the silence rule, and the recommendation conjunction this
 * function implements.
 */
export function buildValveRows({ snapshot, usage }) {
  const snapshotServers = snapshot.status === 'known' ? snapshot.servers : [];
  const wireLabelSet = usage.status === 'observed' ? new Set(Object.keys(usage.usesByLabel)) : new Set();
  const windowMs = usage.windowMs;

  // Group ALL snapshot servers by their sanitized name — a group of size > 1
  // is a collision (Decision 5), independent of whether that sanitized key
  // ever appears on the wire. This mirrors `declaredVsArrived`'s existing
  // `collisions` handling in bin/oxidegate-savings.mjs.
  const bySanitized = new Map();
  for (const server of snapshotServers) {
    const key = sanitizeServerName(server.name);
    if (!bySanitized.has(key)) bySanitized.set(key, []);
    bySanitized.get(key).push(server);
  }

  const rows = [];
  const claimedWireLabels = new Set();
  let matchedCount = 0;

  for (const [sanitizedKey, group] of bySanitized) {
    if (group.length > 1) {
      // COLLISION: neither entry can claim a wire label with any confidence.
      // Both render 'ambiguous'; the wire label (if it has real traffic)
      // stays unclaimed and surfaces separately as an 'unknown' row below.
      // The shared sanitized key MAY still appear on the wire — that IS a
      // correspondence (imperfect, but real), so it counts toward
      // `matchedCount` for joinHealth even though no specific entry claims
      // the label. Without this, a single unrelated collision would falsely
      // read as "the two instruments agree about nothing".
      if (wireLabelSet.has(sanitizedKey)) matchedCount += 1;
      const names = group.map((server) => server.name);
      for (const server of group) {
        rows.push({
          label: server.name,
          join: 'ambiguous',
          snapshotNames: names,
          price: server.price,
          enabled: server.enabled,
          tokens: server.tokens,
          uses: undefined,
          recommendation: undefined,
        });
      }
      continue;
    }

    const [server] = group;
    const match = matchTier(server.name, wireLabelSet);

    if (match) {
      matchedCount += 1;
      claimedWireLabels.add(match.label);
      rows.push({
        label: match.label,
        join: match.join,
        snapshotNames: [server.name],
        price: server.price,
        enabled: server.enabled,
        tokens: server.tokens,
        // No `?? 0` fallback here: `matchTier` only returns a match when
        // `wireLabelSet.has(label)`, and `wireLabelSet` is built from
        // `Object.keys(usage.usesByLabel)` — so a matched `label` is always
        // a present key in `usesByLabel`, and every present key holds a
        // count >= 1. The lookup is total; a fallback would be dead code
        // that misleads a reader into thinking it is reachable. If that
        // invariant is ever violated, `undefined` is the deliberate safe
        // failure: it makes `row.uses === 0` false, so the recommendation
        // gate REFUSES to recommend rather than fabricating a zero that
        // could recommend disabling a server that may still be in use.
        uses: usage.status === 'observed' ? usage.usesByLabel[match.label] : undefined,
        recommendation: undefined,
      });
      continue;
    }

    // SNAPSHOT-ONLY: no wire label matched this name at all. If there is no
    // known price either, this row is "no spend and no price" — silence,
    // per the module header. Do not manufacture a row that says nothing.
    if (server.price.status !== 'known') continue;

    rows.push({
      label: server.name,
      join: 'snapshot-only',
      snapshotNames: [server.name],
      price: server.price,
      enabled: server.enabled,
      tokens: server.tokens,
      uses: usage.status === 'observed' ? 0 : undefined,
      recommendation: undefined,
    });
  }

  // WIRE-ONLY: any observed wire label no resolved snapshot entry claimed.
  // Decision 6: this spend is real and MUST NEVER be dropped, regardless of
  // why it went unclaimed (no matching snapshot entry at all, or a
  // collision that left its label unclaimed above).
  if (usage.status === 'observed') {
    for (const label of Object.keys(usage.usesByLabel)) {
      if (claimedWireLabels.has(label)) continue;
      rows.push({
        label,
        join: 'unknown',
        snapshotNames: undefined,
        price: undefined,
        enabled: undefined,
        tokens: undefined,
        uses: usage.usesByLabel[label],
        recommendation: undefined,
      });
    }
  }

  // joinHealth (Decision 6): fires only when there WERE measured servers to
  // potentially match, wire MCP traffic exists, and NONE of it matched —
  // the exact signature of a broken join, not of an idle fleet.
  const wireMcpCount = usage.status === 'observed' ? Object.keys(usage.usesByLabel).length : 0;
  const joinHealth = snapshotServers.length > 0 && wireMcpCount > 0 && matchedCount === 0 ? 'no-correspondence' : 'ok';

  for (const row of rows) {
    row.recommendation = recommendationFor(row, usage, joinHealth);
  }

  // snapshotFreshness/snapshotTimestamp: verbatim passthrough, gated on
  // `snapshot.status === 'known'` — see "WHY snapshotFreshness AND
  // snapshotTimestamp ARE EXPOSED HERE" above. No snapshot means no
  // freshness; `undefined` stays `undefined`, never a guessed 'stale'.
  const snapshotFreshness = snapshot.status === 'known' ? snapshot.freshness : undefined;
  const snapshotTimestamp = snapshot.status === 'known' ? snapshot.timestamp : undefined;

  return { rows, joinHealth, windowMs, snapshotFreshness, snapshotTimestamp };
}
