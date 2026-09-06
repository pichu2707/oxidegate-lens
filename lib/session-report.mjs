// lib/session-report.mjs
//
// CONTRACT
// --------
// Turns the ALREADY-FETCHED body of OxideGate's `GET /sessions` into the
// structure `bin/oxidegate-sessions.mjs` renders. PURE — no fetch, no clock,
// no disk. NEVER throws: any shape it does not recognize degrades to
// `{ status: 'unexpected-shape' }`, never a thrown error and never an
// invented value.
//
// Exports:
//   buildSessionReport(body) -> SessionReport
//
// SessionReport is one of:
//   { status: 'unexpected-shape' }
//   {
//     status: 'known',
//     saturated: boolean,                 // verbatim from the proxy
//     sessions: SessionRow[],             // is_session === true, cost DESC
//     unattributed: SessionRow[],         // is_session === false
//     unclassified: SessionRow[],         // is_session missing/non-boolean —
//                                          // never dropped, never guessed into
//                                          // either block above
//     fixedToll: TollRow[],               // one per row, session AND
//                                          // unattributed AND unclassified —
//                                          // section (c) is not session-only
//     totals: { sessions: Totals, unattributed: Totals, unclassified: Totals },
//                                          // unclassified's total is its OWN
//                                          // group, never merged into the
//                                          // other two — see hallazgo 2,
//                                          // issue #18 adversarial review
//   }
//
// SessionRow: { key: string|null, source: string|null, requests: number|null,
//   costUsd: number|null, inputTokens: number|null,
//   cacheReadTokens: number|null, outputTokens: number|null }
//
// Totals: { count: number, cost: number|null, requests: number|null,
//   inputTokens: number|null, cacheReadTokens: number|null,
//   outputTokens: number|null }
//
// TollRow: { key: string|null, isSession: boolean|null, requests: number|null,
//   members: { hooks: TollMember, instructions: TollMember, skills: TollMember } }
//
// TollMember is one of:
//   { status: 'unmeasured' }
//   { status: 'known', bytes: number, seenIn: number, product: number|null }
//
// WHY THIS EXISTS
// ----------------
// `GET /sessions` answers "what did THIS SESSION cost", a different currency
// from the byte-per-request report `bin/oxidegate-savings.mjs` already
// prints. Measured against a real 0.13.0 proxy: 43% of the rows this
// endpoint returns are NOT sessions at all — they are unattributed buckets
// keyed by User-Agent (`source: 'unattributed'`) — and 34% of the observed
// input tokens live in rows that report `cost_usd: 0`. A report that ranked
// everything by cost, or that printed that zero as a bare "$0.00", would
// have handed the reader a confidently wrong answer built from real numbers.
// This module exists so nothing downstream has to reconstruct that judgment
// call from raw JSON — see the four rules below, each with its own test.
//
// RULE 1 — `cost_usd === 0` does NOT imply `is_session === false`
// ------------------------------------------------------------------
// The correlation holds in every sample measured so far, and that is exactly
// why it must not become a rule: an unpriced model would report a REAL
// session with a real `cost_usd: 0`. Classification into `sessions` /
// `unattributed` / `unclassified` reads ONLY `is_session`
// (`true` / `false` / anything else), never `cost_usd`. `costUsd` is passed
// through UNCHANGED — a real `0` stays `0`, never coerced into `null` and
// never used to reclassify the row.
//
// RULE 2 — an absent field is `null`, never `0`
// ------------------------------------------------------------------
// Same invariant `lib/mcp-snapshot.mjs` and `lib/proxy-version.mjs` already
// hold, stated once here because it governs every field on `SessionRow`:
// an absent measurement is never a zero measurement. A missing or
// non-numeric `cost_usd` (etc.) normalizes to `null`, which is a DIFFERENT
// claim from a measured `0`. Rendering the difference between the two is the
// caller's job (see `bin/oxidegate-sessions.mjs`'s "no atribuible" marker);
// this module only guarantees the two never collapse into each other.
//
// RULE 3 — a `null` `fixed_toll` member is `unmeasured`, never `0 bytes`
// ------------------------------------------------------------------
// `fixed_toll.{hooks,instructions,skills}` is `null` when OxideGate never
// measured that member for this row — NOT when it measured zero bytes. A
// malformed member (an object missing `bytes` or `seen_in`, or of the wrong
// type) degrades to the SAME `unmeasured` state rather than a fabricated
// partial figure: better to say nothing than to print a byte count that was
// never actually measured.
//
// RULE 4 — `sessions` and `unattributed` are NEVER ranked together
// ------------------------------------------------------------------
// They are two separate arrays, each sorted (or left unsorted) on its own
// terms — no shared list, no shared index, no merge step anywhere in this
// module. `unattributed` rows are per-client buckets (User-Agent), not
// sessions; treating them as comparable to a real session's cost is the
// exact confusion `source: 'unattributed'` exists to prevent.
//
// TOTALS — `sumOrUnknown` semantics (same rule as `bin/oxidegate-savings.mjs`)
// ------------------------------------------------------------------
// A group total for a given field is the sum ONLY when every row in that
// group reports a numeric value for that field. One silent row poisons the
// WHOLE field's total (`null`), never a partial sum presented as complete.
// An EMPTY group is different: nobody was silent, there is nothing to sum,
// so its total is a real `0`.
//
// THE TOLL PRODUCT — the N² thesis, measured, not argued
// ------------------------------------------------------------------
// For a known `{bytes, seen_in}` member, the "repeated cost" figure
// (`bytes * seen_in`) is the whole point of this block: a fixed per-turn
// payload (a skill's system-prompt bytes, say) that gets sent again on every
// turn it was seen in. It is computed ONLY when the row's `requests` is also
// known — not because the multiplication needs it, but because presenting
// "repeated N times" without knowing how many turns this session had at all
// invites a reading the row cannot support. `bytes` and `seenIn` are still
// exposed even when `requests` is unknown; only `product` gates on it.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toOptionalString(value) {
  return typeof value === 'string' ? value : null;
}

function toOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normaliza una fila cruda a `SessionRow` — ver cabecera del módulo. */
function normalizeRow(raw) {
  return {
    key: toOptionalString(raw.key),
    source: toOptionalString(raw.source),
    requests: toOptionalNumber(raw.requests),
    costUsd: toOptionalNumber(raw.cost_usd),
    inputTokens: toOptionalNumber(raw.input_tokens),
    cacheReadTokens: toOptionalNumber(raw.cache_read_tokens),
    outputTokens: toOptionalNumber(raw.output_tokens),
  };
}

/**
 * Un miembro de `fixed_toll`. Ver RULE 3 — `null` y "malformado" degradan a
 * la MISMA respuesta, `{ status: 'unmeasured' }`: nunca un byte fabricado.
 */
function normalizeTollMember(raw) {
  if (!isPlainObject(raw)) return { status: 'unmeasured' };
  const bytes = toOptionalNumber(raw.bytes);
  const seenIn = toOptionalNumber(raw.seen_in);
  if (bytes === null || seenIn === null) return { status: 'unmeasured' };
  return { status: 'known', bytes, seenIn };
}

/** Ver "THE TOLL PRODUCT" en la cabecera: el producto sólo se calcula si `requests` es conocido. */
function buildTollRow(raw, normalizedRequests) {
  const rawToll = isPlainObject(raw.fixed_toll) ? raw.fixed_toll : {};
  const members = {};
  for (const name of ['hooks', 'instructions', 'skills']) {
    const member = normalizeTollMember(rawToll[name]);
    if (member.status === 'known') {
      member.product = normalizedRequests === null ? null : member.bytes * member.seenIn;
    }
    members[name] = member;
  }
  return {
    key: toOptionalString(raw.key),
    isSession: raw.is_session === true ? true : raw.is_session === false ? false : null,
    requests: normalizedRequests,
    members,
  };
}

/**
 * Suma `rows[i][key]` — `null` si CUALQUIER fila calla ese campo (no numérico
 * o ausente), `0` real si `rows` está vacío. Misma disciplina que
 * `sumOrUnknown` en `bin/oxidegate-savings.mjs`, ver cabecera "TOTALS".
 */
function sumField(rows, key) {
  let sum = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'number' || Number.isNaN(value)) return null;
    sum += value;
  }
  return sum;
}

function buildTotals(rows) {
  return {
    count: rows.length,
    cost: sumField(rows, 'costUsd'),
    requests: sumField(rows, 'requests'),
    inputTokens: sumField(rows, 'inputTokens'),
    cacheReadTokens: sumField(rows, 'cacheReadTokens'),
    outputTokens: sumField(rows, 'outputTokens'),
  };
}

/**
 * Orden por coste DESCENDENTE. Filas con `costUsd: null` van al final,
 * conservando su orden original entre sí — no se puede rankear lo que no se
 * conoce (RULE 4 / RULE 2), así que ni siquiera se intenta.
 */
function sortByCostDesc(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ca = a.row.costUsd;
      const cb = b.row.costUsd;
      if (ca === null && cb === null) return a.index - b.index;
      if (ca === null) return 1;
      if (cb === null) return -1;
      return cb - ca;
    })
    .map(({ row }) => row);
}

/**
 * Construye el reporte completo a partir del body YA TRAÍDO de `/sessions`.
 * NUNCA lanza — ver cabecera del módulo.
 */
export function buildSessionReport(body) {
  if (!isPlainObject(body)) return { status: 'unexpected-shape' };
  if (typeof body.saturated !== 'boolean') return { status: 'unexpected-shape' };
  if (!Array.isArray(body.sessions)) return { status: 'unexpected-shape' };

  const sessions = [];
  const unattributed = [];
  const unclassified = [];
  const fixedToll = [];

  for (const raw of body.sessions) {
    if (!isPlainObject(raw)) continue;

    const normalized = normalizeRow(raw);
    if (raw.is_session === true) sessions.push(normalized);
    else if (raw.is_session === false) unattributed.push(normalized);
    else unclassified.push(normalized);

    fixedToll.push(buildTollRow(raw, normalized.requests));
  }

  return {
    status: 'known',
    saturated: body.saturated,
    sessions: sortByCostDesc(sessions),
    unattributed,
    unclassified,
    fixedToll,
    totals: {
      sessions: buildTotals(sessions),
      unattributed: buildTotals(unattributed),
      unclassified: buildTotals(unclassified),
    },
  };
}
