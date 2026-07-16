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
| **Can I act on it?** | OpenCode SDK `client.mcp.connect` / `.disconnect` | The valve. Flipped by the human, never by lens. |

### The recommendation rule (settled — do not reopen)

**`0 uses = cost with no return = candidate to disable`.**

Chosen deliberately because it **survives multi-harness**: it needs no
tokenizer and no context-window assumption. A server whose tools never appear
in `tools_by_server` across the observed window is paying rent and producing
nothing. That statement is true regardless of provider, model, or tokenizer
availability.

### Informs and recommends. Never acts.

The valve MAY label a server "candidate to disable". A human flips the switch.
The product pitch promises *"measures, does not auto-optimize"* — this change
honors it literally. No auto-disable, no "smart" pruning, no background
mutation of the user's MCP config.

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

### Bytes are the floor, tokens are the headline only when exact

- **BYTES are the universal floor.** OxideGate measures them on the wire for
  any provider. They always exist.
- **TOKENS are the headline ONLY where the tokenizer is exact.** Per the
  HONESTY NOTE in `packages/core/src/tokenize.ts`, local tokenization is exact
  **only** for the OpenAI o200k_base family. For all Claude models
  `countTokens` returns `null`.
- **`null` means "no accurate tokenizer". It NEVER means zero.** Coercing
  `null` to `0` is forbidden. On Claude Code the headline **degrades to bytes**
  rather than rendering a blank or a lie.

## Scope

### In scope — oxidegate-lens (this repo)

- Read `~/.config/mcp-savings/snapshot.json` with plain `fs` + `JSON.parse`,
  defensively (missing file, malformed JSON, unknown/older shape, partial
  write → degrade, never throw).
- Join snapshot cost data with OxideGate wire usage (`tools_by_server`) per MCP
  server.
- Apply the `0 uses = candidate to disable` rule and label accordingly.
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
- **Auto-acting is OUT.** No auto-disable, no automatic config mutation, no
  background optimization. The human flips the switch. Always.
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

## Risks and tradeoffs

| Topic | Detail | Treatment |
|-------|--------|-----------|
| **Two-repo slice** | The full informed valve spans lens and mcp-savings. Larger blast radius than a single-repo change, and the review budget is real. | Accepted deliberately by the user over a smaller slice. Split into chained PRs at task time; the lens read-side lands first and degrades gracefully with no mcp-savings change at all. |
| **Untyped file across a version boundary** | The snapshot is written by a separately-versioned tool. Its shape can drift without lens noticing until runtime. | Defensive parsing is mandatory. Unknown shape → treat as missing. The `timestamp` field gates staleness. This is the accepted cost of loose coupling; a runtime dep would trade it for a worse coupling. |
| **Schema bytes ≠ wire bytes** | mcp-savings re-serializes schemas locally; the host may serialize differently. The two byte numbers can disagree. | Do NOT reconcile them into one number. Label them as different qualities (b vs a). Disagreement is information, not a bug to hide. |
| **`null` tokens on Claude** | The headline metric disappears on the most likely harness for this user. | By design. Degrade to bytes — the universal floor. NEVER coerce `null` to `0`. A blank is dishonest; a zero is a lie. |
| **`0 uses` depends on the observation window** | A server used once a week reads as "0 uses" on a fresh OxideGate. The recommendation could be wrong. | It is a **recommendation**, never an action — this is exactly why the valve never auto-acts. The window MUST be surfaced with the label so the human can judge. |
| **Panel removal is user-visible** | Retiring the mcp-savings sidebar panel removes a surface someone may already rely on. | Sequence it: lens' informed surface lands **first**, the mcp-savings panel retires **after**. Never a gap with no permanent surface. |
| **Stale snapshot mistaken for current** | A price from last week presented as today's is worse than no price. | The `timestamp` is not optional in the UI. Stale is labeled stale. |
| **Discovery invite becomes nagging** | "Install mcp-savings" on every render is an ad, not a hint. | Keep it a quiet, one-line, non-blocking hint. It follows the existing `probeEndpoint` precedent: say it once, clearly, then be quiet. |

Cross-cutting principle (non-negotiable): **unknown is `null`/absent, never an
invented number.** Bytes are the floor. Tokens are a headline only where exact.
The valve informs; the human acts.

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
- A server with 0 entries in `tools_by_server` across the observed window is
  labeled **candidate to disable**, with the window stated. Nothing is
  disabled automatically.
- On a Claude model, tokens are **absent** and the headline degrades to bytes.
  No `0` appears where a tokenizer is missing.
- With `~/.config/mcp-savings/snapshot.json` deleted, lens still starts, the
  valve still toggles, and the surface invites installing mcp-savings.
- With the snapshot corrupted to invalid JSON, lens degrades to the missing
  case and does not throw.
- `package.json` still declares exactly one dependency: `@opencode-ai/plugin`.
- Wire bytes, schema bytes, exact tokens, and absent tokens are each
  distinguishable on the surface. No single number blends them.
- `node --test test/*.test.mjs` passes.

## Next step

With this proposal approved, `sdd-spec` and `sdd-design` proceed in parallel:

- **`sdd-spec`** — the data contract: the snapshot fields lens consumes, the
  defensive-parse and staleness rules, the four data qualities and their
  labels, and the `0 uses` recommendation rule as Given/When/Then scenarios.
- **`sdd-design`** — the architecture: where the snapshot reader lives in
  `lib/`, how the wire/snapshot join is shaped, the degradation paths, and the
  sequencing that retires the mcp-savings panel without leaving a gap.
