# Proposal — Informed MCP valve: price the switch before the human flips it

This proposal turns oxidegate-lens' MCP valve from **blind** into **informed**.
Today the valve can tell you a server is configured-but-absent from the wire; it
cannot tell you what enabling it would **cost**. The price tag already exists —
mcp-savings measures it counterfactually — but nothing connects the two tools.
The user is asked to decide "should I enable this?" with no number attached.

The connection is deliberately **file-based**: mcp-savings already writes
`~/.config/mcp-savings/snapshot.json` (verified live, 4.1KB), and lens reads it
with plain `fs` + `JSON.parse`. No runtime dependency, no shared package, no
coupling. Each tool keeps shipping independently.

This slice delivers the **full informed valve**: price + real usage + toggle.
That is a deliberate choice over a smaller first slice, made knowing it spans
two repos.

## Why (the problem)

- **The valve is blind.** lens reads only OxideGate's wire data
  (`GET /requests` → `tools_by_server`, `tools_overhead_bytes`), which is "what
  actually arrived". A server that is off sends nothing, so the wire has no
  opinion about it. The counterfactual — "what WOULD this cost" — is
  structurally invisible to OxideGate. It is not a missing feature; it is the
  wrong instrument for that question.
- **The answer already exists, unused.** mcp-savings connects directly to MCP
  servers via the official MCP SDK (`packages/core/src/measure.ts`) and knows
  the schema cost of a server **even when it is off**. Real observed value:
  server `engram` = 18 tools, 17233 bytes, 3788 tokens. That number never
  reaches the surface where the decision is actually made.
- **The decision surface and the price live in different tools.** lens owns the
  permanent, actionable face (show what matters now, toggle servers).
  mcp-savings owns the on-demand detailed report (`/saving`). Neither one alone
  can answer "is this server worth its schema?".
- **Accidental duplication is already happening.** mcp-savings ships a
  permanent OpenCode sidebar panel (`packages/opencode/src/panel.ts`), written
  one hour after lens' own live-MCP-state work, the same evening. Two tools
  independently grew the same always-on surface. That overlap needs resolving,
  not preserving.

## What (the informed valve)

One surface that answers three questions at once, per MCP server:

| Question | Source | Nature |
|----------|--------|--------|
| **What does it cost?** | mcp-savings snapshot (`mcpMeasurement[].bytes` / `.tokens`) | Counterfactual. Known even when the server is off. |
| **Is it earning it?** | OxideGate `GET /requests` → `tools_by_server` | Measured fact on the wire. |
| **Can I act on it?** | OpenCode SDK `client.mcp.connect` / `.disconnect` | The valve. Opened and closed under the user's declared policy, never under lens' own judgment. |

### The recommendation rule (settled — do not reopen)

Three inputs, three distinct outcomes. The rule is not one branch; it is a
partition, and every branch is named so none can be silently absent:

| Observed on the wire | Priced by the snapshot | Outcome |
|---|---|---|
| spend, attributable to a known server | yes | Normal row: price + usage. |
| spend, attributable to **no** snapshot server | — | Row labeled **`unknown`** (unattributed). **NEVER dropped.** |
| **no spend** | no price | **Silence.** No recommendation, no nag. |
| **no spend** | has a price tag | **`candidate to disable`** — cost with no return. Always shipped with its observation window. |

**`0 uses = cost with no return = candidate to disable`** was chosen
deliberately because it **survives multi-harness**: it needs no tokenizer and no
context-window assumption. A server whose tools never appear in
`tools_by_server` across the observed window is paying rent and producing
nothing. That statement is true regardless of provider, model, or tokenizer
availability.

**The wire is the authority on spend.** Wire spend that matches no snapshot
server MUST still be shown, as its own `unknown` row. Dropping it is the worst
available outcome: it deletes evidence of real money spent. An `unknown` row
carrying real spend is the **tell-tale of a broken join** — it converts a
silent, invisible mismatch into something a human can SEE and act on. Being
unable to attribute spend is a fact about lens' knowledge, not a fact about the
spend.

### The valve is a TAP: it informs, it does not decide FOR you

The valve MAY label a server "candidate to disable". A human decides. The
product pitch promises *"measures, does not auto-optimize"*, and this is what
that promise means — **precisely**:

| Legitimate (ships, stays) | Forbidden (never ships) |
|---|---|
| **Starting closed is the user's declared policy, applied.** The user marks which servers start disabled (`OXIDEGATE_MCP_DISABLE_BY_DEFAULT` + `OXIDEGATE_MCP_ALLOWLIST`, or all of them); they open on demand. | **Autonomous policy change.** lens deciding on its own to close a tap because an algorithm judged a server unused. |

The water is always there. The tap lets it through or cuts it off **according to
the user's need, as the user declared it**. `disableMcpServersByDefault`
(`opencode/oxidegate-lens.ts:165`, invoked at load, line 311) is that tap
mechanism and is an intentional, shipped feature — not a design violation.

The line that must never be crossed: **the recommendation MUST NEVER auto-feed
the default-off policy.** The recommendation informs the human's *marking*; it
never becomes the marking. What separates the two is not "lens never acts" — it
is *whose judgment acted*: **user-declared policy vs. tool-inferred opinion.**

### The file contract (hard constraint)

lens is zero-runtime-dependency by design (only declared dep:
`@opencode-ai/plugin`, a peer for the host). Per `openspec/config.yaml`, this
is **non-negotiable**:

- lens **MUST NEVER** take a runtime dependency on `@mcp-savings/core`.
- Integration is a **file contract**: mcp-savings writes
  `~/.config/mcp-savings/snapshot.json` (`packages/core/src/config.ts::snapshotPath`);
  lens reads it with plain `fs` + `JSON.parse`.
- Consequence accepted: lens must **defensively parse** the snapshot. It is an
  untyped file on disk written by a different tool on a different release
  cadence. Missing fields, older shapes, and partial writes are normal inputs,
  not exceptions.

Snapshot shape consumed (verified live):

```
{ timestamp, host, model,
  serverWeights: [{ server, tools: [{id, bytes}], bytes }],
  totalSchemaBytes,
  sessionTokens: { input, output, reasoning, cacheRead, cacheWrite },
  mcpMeasurement: [{ server, ok, enabled, tools: [{name, bytes, tokens}], bytes, tokens }] }
```

### The four qualities of number (honesty invariant)

The surface blends data from two measurement instruments. They are **not the
same kind of fact** and MUST be labeled distinctly. Blending them into one
number would imply a precision this product does not have.

| # | Number | Source | Quality |
|---|--------|--------|---------|
| a | **Wire bytes** | OxideGate, on the wire | **Measured fact.** What actually crossed the network. |
| b | **Schema bytes** | mcp-savings, local MCP SDK | **Measured locally, re-serialized.** Real, but may differ from the wire — the host may serialize differently. |
| c | **Tokens (OpenAI)** | `packages/core/src/tokenize.ts`, o200k_base | **Exact.** |
| d | **Tokens (Claude)** | — | **Absent.** `countTokens` returns `null`. |
| e | **Bytes, unmeasurable** | mcp-savings, `ok: false` | **Absent.** The connect/list failed. `bytes: 0` is the sum of an empty list — a real zero that means "could not measure". |

### THE honesty invariant: an absent measurement is never a zero measurement

One rule, covering **both** bytes and tokens. They are the same door, and it
must be shut on both sides:

| Instrument says | Means | MUST render as | MUST NEVER render as |
|---|---|---|---|
| `tokens: null` | "no accurate tokenizer for this model" | absent; headline degrades to bytes | `0 tok` |
| `ok: false` | "could not measure this server" | **"cannot measure" / price unknown** | `0 B` |

- **BYTES are the universal floor.** OxideGate measures them on the wire for
  any provider. They always exist *on the wire*. They do **not** always exist in
  the snapshot: when mcp-savings could not reach a server (`ok: false`), its
  price is **unknown**, and saying so is better than reporting `0`.
- **TOKENS are the headline ONLY where the tokenizer is exact.** Per the
  HONESTY NOTE in `packages/core/src/tokenize.ts`, local tokenization is exact
  **only** for the OpenAI o200k_base family. For all Claude models
  `countTokens` returns `null`. On Claude Code the headline **degrades to bytes**
  rather than rendering a blank or a lie.
- **Neither `null` nor `ok: false` may be coerced to `0`.** A blank is
  dishonest; a zero is a lie. "I could not measure this" is a first-class,
  renderable answer.

**Field-presence checking does not guard this door.** `ok: false` ships a
`bytes` field that is present, typed, numeric, and meaningless. Any check that
asks "does `.bytes` exist?" waves it through. The check MUST test the **`ok`
flag**, not the presence of `.bytes`.

## Scope

### In scope — oxidegate-lens (this repo)

- Read `~/.config/mcp-savings/snapshot.json` with plain `fs` + `JSON.parse`,
  defensively (missing file, malformed JSON, unknown/older shape, partial
  write → degrade, never throw).
- Join snapshot cost data with OxideGate wire usage (`tools_by_server`) per MCP
  server, surfacing unattributable wire spend as an `unknown` row rather than
  dropping it.
- Apply the `0 uses = candidate to disable` rule and label accordingly, always
  with its observation window.
- Render the informed valve surface: per server, its price, its real usage, its
  recommendation, and its toggle.
- Graduate the EXPERIMENTAL valve tools
  (`oxidegate_lens_experimental_mcp_status/_connect/_disconnect` in
  `opencode/oxidegate-lens.ts`) into the informed surface.
- Correct the outdated header comment in `opencode/oxidegate-lens.ts` (see
  Corrections below).
- Handle the missing/stale snapshot as a **discovery moment**, not an error
  (see Degradation).

### In scope — mcp-savings (sibling repo)

- Resolve the overlapping permanent sidebar panel
  (`packages/opencode/src/panel.ts`). Per the settled product split, the
  **permanent always-on surface belongs to lens**; mcp-savings keeps the
  on-demand `/saving` detailed report. The panel is moved or retired.
- Any snapshot-writing guarantees lens needs to depend on (freshness,
  atomicity) are stated as a contract mcp-savings honors — **not** as an API
  lens imports.

### Non-goals (explicit)

- **Routing is OUT.** Whether OpenCode traffic reaches OxideGate is a separate
  concern. This change does not touch it.
- **Autonomous policy change is OUT.** lens never decides on its own which
  servers to close. The recommendation MUST NEVER feed
  `disableMcpServersByDefault`'s allowlist. Applying the user's *declared*
  default-off policy is NOT in this non-goal — that is the tap working as
  designed (see "The valve is a TAP" above).
- **No runtime dependency on `@mcp-savings/core`.** Not now, not "just for
  types", not "just for `loadSnapshot`". The file contract is the contract.
- **lens does not measure anything itself.** It stays a read-only presentation
  layer over OxideGate's HTTP endpoints and the mcp-savings snapshot file. No
  MCP SDK client in lens.
- **No tokenizer in lens.** If tokens aren't in the snapshot, lens shows bytes.
  It does not estimate.
- **No new metric invented.** Bytes and tokens as already defined by the two
  upstream tools. Nothing derived, blended, or "normalized".
- **No context-window percentage.** It would require a per-model window
  assumption that breaks the multi-harness property of the recommendation rule.

## Degradation (the snapshot is optional, by design)

lens **MUST remain fully functional standalone**. mcp-savings is an
enhancement, not a prerequisite.

| Snapshot state | Behavior |
|----------------|----------|
| **Present and fresh** | Full informed valve: price + usage + recommendation. |
| **Missing** | Valve still works with wire data only (usage + toggle, no price). Surface **invites the user to install mcp-savings** — the gap becomes discovery, not a dead end. |
| **Stale** | Cost data shown, **labeled stale** with its `timestamp`. A stale price is still better than no price, as long as it is not passed off as current. |
| **Malformed / unknown shape** | Degrade to the missing case. Never throw, never crash the host plugin. |

The invitation is the point: a user who never heard of mcp-savings discovers it
at the exact moment its value is obvious — while staring at a switch they can't
price.

## Corrections to existing claims

The header comment in `opencode/oxidegate-lens.ts` states that OpenCode traffic
**cannot** be routed through OxideGate, because a plugin has no way to set a
provider `baseURL`. **That claim is now outdated.** A fetch-patch plugin
(`~/.config/opencode/plugins/oxidegate-codex.ts`) does exactly that today and
works.

The comment gets corrected as part of this change. Routing itself stays out of
scope — this is a documentation honesty fix, not a feature.

## Revision record — what these rulings reversed, and why

These artifacts are a decision record, not a rewritable draft. Where a ruling
overturned earlier text, the earlier position is preserved here so the next
reader inherits the *distinction*, not a silently edited history.

| # | What this proposal used to say | What it says now | Why it changed |
|---|---|---|---|
| **1** | Silent on unattributable wire spend. The join's `snapshot-only` rows made "0 uses" and "name mismatch" indistinguishable, with no row-level tie-breaker. | Wire spend matching no snapshot server surfaces as an `unknown` row and is **never dropped**. No spend + no price → silence. | The wire is the authority on spend. A dropped row is the worst outcome; an `unknown` row makes a mismatch **self-evident to a human**. Complements the fleet-level `joinHealth` guard — does not replace it. |
| **2** | "REQUIRED `.bytes`" — satisfied by field presence. `ok: false` yields `bytes: 0`, passing the check while meaning "could not measure". | `ok: false` → **"cannot measure" / price unknown**, never `0`. Stated as ONE honesty invariant covering bytes and tokens together. | An absent measurement is never a zero measurement. The rule already enforced for `tokens: null` had a second door — bytes — that field-presence checking does not guard. |
| **3** | *"Informs and recommends, NEVER acts"*; *"no background mutation of the user's MCP config"*. | **The valve is a TAP.** Starting closed is the user's declared policy, applied — legitimate. What is forbidden is **autonomous policy change**. | **This corrects an error, not a change of mind.** The blanket framing condemned `disableMcpServersByDefault` — an intentional shipped feature — as a design violation. The real line is *whose judgment acted*: user-declared policy vs. tool-inferred opinion. The existing firewall (recommendation never feeds the default-off policy) was always correct; only its rationale needed sharpening. |

## Risks and tradeoffs

| Topic | Detail | Treatment |
|-------|--------|-----------|
| **Two-repo slice** | The full informed valve spans lens and mcp-savings. Larger blast radius than a single-repo change, and the review budget is real. | Accepted deliberately by the user over a smaller slice. Split into chained PRs at task time; the lens read-side lands first and degrades gracefully with no mcp-savings change at all. |
| **Untyped file across a version boundary** | The snapshot is written by a separately-versioned tool. Its shape can drift without lens noticing until runtime. | Defensive parsing is mandatory. Unknown shape → treat as missing. The `timestamp` field gates staleness. This is the accepted cost of loose coupling; a runtime dep would trade it for a worse coupling. |
| **Schema bytes ≠ wire bytes** | mcp-savings re-serializes schemas locally; the host may serialize differently. The two byte numbers can disagree. | Do NOT reconcile them into one number. Label them as different qualities (b vs a). Disagreement is information, not a bug to hide. |
| **`null` tokens on Claude** | The headline metric disappears on the most likely harness for this user. | By design. Degrade to bytes — the universal floor. NEVER coerce `null` to `0`. A blank is dishonest; a zero is a lie. |
| **`ok: false` ships a plausible `0`** | mcp-savings sums an empty tool list when the connect/list fails, so an unmeasurable server arrives typed, present, and `0`. A field-presence check waves it through. | Test the **`ok` flag**, not the presence of `.bytes`. Map `ok: false` → price unknown, discard its `bytes`. Same invariant as `null` tokens: absent is not zero. |
| **Unattributable wire spend** | Wire traffic that matches no snapshot server has no home row. Dropping it would delete evidence of real spend and hide a broken join. | Surface it as an `unknown` row. Never drop it. The row is the tell-tale that makes a naming mismatch visible to a human instead of silent. |
| **`0 uses` depends on the observation window** | A server used once a week reads as "0 uses" on a fresh OxideGate. The recommendation could be wrong. | It is a **recommendation**, never an autonomous act — the human decides what gets marked. The window MUST be surfaced with the label so the human can judge. |
| **Panel removal is user-visible** | Retiring the mcp-savings sidebar panel removes a surface someone may already rely on. | Sequence it: lens' informed surface lands **first**, the mcp-savings panel retires **after**. Never a gap with no permanent surface. |
| **Stale snapshot mistaken for current** | A price from last week presented as today's is worse than no price. | The `timestamp` is not optional in the UI. Stale is labeled stale. |
| **Discovery invite becomes nagging** | "Install mcp-savings" on every render is an ad, not a hint. | Keep it a quiet, one-line, non-blocking hint. It follows the existing `probeEndpoint` precedent: say it once, clearly, then be quiet. |

Cross-cutting principle (non-negotiable): **unknown is `null`/absent, never an
invented number** — for bytes and tokens alike. Bytes are the floor. Tokens are
a headline only where exact. Observed spend is never dropped. The valve informs;
the human decides what policy to declare.

## Rollback plan

- **lens read-side**: purely additive. The snapshot read is a new code path
  guarded by "file exists and parses". `git revert` of the slice removes the
  price column; the valve returns to its current wire-only behavior. No
  persistent state, no schema to version, no migration.
- **mcp-savings panel retirement**: reverting restores the panel. Because the
  panel is a rendering surface over a snapshot file it does not own, restoring
  it has no data consequences. Worst case: the overlap comes back temporarily.
- **Ordering makes rollback safe**: since lens' surface lands before the panel
  retires, reverting either side independently always leaves at least one
  working permanent surface.

## Success criteria

- A configured-but-disabled MCP server shows its **price** (bytes, and tokens
  only where exact) in the lens valve surface — a number that does not exist on
  the wire.
- A server with 0 entries in `tools_by_server` across the observed window **and
  a known price** is labeled **candidate to disable**, with the window stated.
  Nothing is disabled by lens' own judgment.
- A server with no observed spend **and** no price tag produces **no
  recommendation at all** — the surface stays silent about it.
- Wire spend attributable to no snapshot server renders as an `unknown` row. No
  observed spend is ever dropped from the surface.
- On a Claude model, tokens are **absent** and the headline degrades to bytes.
  No `0` appears where a tokenizer is missing.
- A snapshot entry with `ok: false` renders as **"cannot measure"**, never as
  `0 B` — even though its `bytes` field is present and numeric.
- `disableMcpServersByDefault` still applies the user's declared default-off
  policy at plugin load, and no valve row reaches it.
- With `~/.config/mcp-savings/snapshot.json` deleted, lens still starts, the
  valve still toggles, and the surface invites installing mcp-savings.
- With the snapshot corrupted to invalid JSON, lens degrades to the missing
  case and does not throw.
- `package.json` still declares exactly one dependency: `@opencode-ai/plugin`.
- Wire bytes, schema bytes, exact tokens, and absent tokens are each
  distinguishable on the surface. No single number blends them.
- `node --test test/*.test.mjs` passes.

## Next step

`sdd-spec` and `sdd-design` are complete, and all three artifacts now carry the
rulings above:

- **`spec.md`** — the data contract: the snapshot fields lens consumes, the
  defensive-parse and staleness rules, the data qualities and their labels, the
  `ok`-flag guard, the `unknown` row, and the `0 uses` rule as Given/When/Then
  scenarios.
- **`design.md`** — the architecture: the `lib/` modules, the FULL OUTER JOIN,
  the derived window and sufficiency gate, `joinHealth`, the topology firewall
  (Decision 8), and the panel-retirement sequencing.

**Next: `sdd-tasks`** — break the three PRs of the sequencing table into
implementable steps. Note for that phase: the review-workload forecast should
account for this being a two-repo slice; PR 1 (lens) stands alone and lands
first.
