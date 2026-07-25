# Informed MCP Valve — Data Contract and Behavior Specification

## Purpose

Defines the data contract lens consumes from `~/.config/mcp-savings/snapshot.json`
and the behavioral rules for the informed valve: defensive parsing,
staleness, the `0 uses` recommendation, the honesty invariant, and
degradation across OxideGate/snapshot availability. Does NOT define file
layout or implementation structure — that is `sdd-design`'s contract.

## Out of Scope

Routing, autonomous policy change (lens deciding on its own which servers to
disable), tokenizer estimation, context-window percentage, any runtime
dependency on `@mcp-savings/core`.

Applying the user's declared default-off policy
(`OXIDEGATE_MCP_DISABLE_BY_DEFAULT` / `OXIDEGATE_MCP_ALLOWLIST`) is an EXISTING
shipped behavior and is NOT out of scope as a violation — it is the tap. See
"Valve informs; the human declares policy" below.

## ADDED Requirements

### Requirement: Snapshot field contract

REQUIRED fields: `timestamp`, `mcpMeasurement[].server`, `.bytes`. All other
fields (`.tokens`, `serverWeights`, `totalSchemaBytes`, `sessionTokens`,
`model`, `host`, `.ok`, `.enabled`) are OPTIONAL. A missing REQUIRED field on
an entry MUST drop that entry's price data only, never the whole snapshot. A
missing OPTIONAL field MUST render as absent, never `0` or invented.

Field presence is NOT sufficient to establish a measurement. `.bytes` MUST be
read as a price ONLY when `.ok !== false` (see "Unmeasurable is not zero").

#### Scenario: Entry missing bytes

- GIVEN an `mcpMeasurement` entry with `bytes` missing
- WHEN lens joins snapshot data for that server
- THEN it renders with no price, not a crash or fabricated `0`

### Requirement: Defensive parsing never throws

A missing file, malformed JSON, or unrecognized shape MUST degrade to the
missing-snapshot case. Lens MUST NEVER throw or crash the host plugin as a
result of snapshot content.

#### Scenario: Malformed JSON

- GIVEN `snapshot.json` contains invalid JSON
- WHEN lens reads it
- THEN lens degrades to missing-snapshot and keeps rendering, no exception

### Requirement: Staleness labeling

Lens MUST compare `timestamp` to current time and label the snapshot
**stale** when older than 24 hours. Stale price data MUST still render,
tagged with its `timestamp`, never presented as current.

#### Scenario: Snapshot older than 24h

- GIVEN a snapshot with `timestamp` 30 hours in the past
- WHEN lens renders the valve surface
- THEN price data renders labeled "stale" with the original `timestamp`

### Requirement: Observed spend is never dropped — unattributable spend renders as `unknown`

The wire is the authority on spend. Wire usage (`tools_by_server`) that
corresponds to no server in the snapshot MUST still render, as its own row
labeled `unknown` (unattributed). Lens MUST NEVER drop an observed-spend row
because it could not attribute it.

An `unknown` row carrying real spend is the intended, visible signal of a broken
join between the two instruments. It complements the fleet-level `joinHealth`
guard; it does NOT replace it.

#### Scenario: Wire spend matches no snapshot server

- GIVEN `tools_by_server` reports usage for a label present in no
  `mcpMeasurement` entry
- WHEN lens builds the valve rows
- THEN a row labeled `unknown` renders carrying that observed spend, and the row
  is not dropped

#### Scenario: Unknown row is not a recommendation

- GIVEN an `unknown` row with observed spend
- WHEN lens renders it
- THEN it states the spend and its unattributed status; it carries no
  "candidate to disable" label

### Requirement: No observed spend and no price → silence

Lens MUST NOT emit a recommendation for a server with no observed spend and no
known price. It MUST stay silent about it: no recommendation, no nag. A
recommendation REQUIRES a known price — cost with no return.

#### Scenario: No spend, no price

- GIVEN a server with 0 observed uses and no price data in the snapshot
- WHEN lens renders the valve surface
- THEN no recommendation renders for that server

### Requirement: `0 uses` recommendation always carries its window

Lens MUST label a server "candidate to disable" only when it has a known price
AND its tools have 0 occurrences in `tools_by_server` across the observed
window, and MUST always render that window with the label. A bare "0 uses" or
bare "candidate to disable" MUST NEVER appear.

#### Scenario: Priced server, zero uses

- GIVEN a server with a known price and 0 occurrences in `tools_by_server`
- WHEN lens renders its recommendation
- THEN it is labeled "candidate to disable" with its observation window

#### Scenario: Zero uses, window stated

- GIVEN server `foo` has 0 entries in `tools_by_server` over a 3h window
- WHEN lens renders `foo`'s recommendation
- THEN it shows "candidate to disable — 0 uses in the last 3h"

#### Scenario: Window is never omitted

- GIVEN any server with 0 observed uses
- WHEN lens renders its recommendation
- THEN the label always includes an explicit window

### Requirement: Honesty invariant — an absent measurement is never a zero measurement

ONE invariant, covering bytes AND tokens. Lens MUST distinguish these number
qualities without blending them: wire bytes (measured fact), schema bytes
(measured locally, may differ from wire), exact tokens (OpenAI o200k_base),
absent tokens (Claude, `countTokens` returns `null`), and unmeasurable bytes
(`ok: false`).

An absent measurement MUST NEVER render as `0` — neither `null` tokens nor
unmeasurable bytes. When tokens are absent, the headline MUST degrade to bytes.

#### Scenario: Claude model, tokens null

- GIVEN `mcpMeasurement[].tokens` is `null`
- WHEN lens renders the cost headline
- THEN it shows bytes; no `0` tokens figure renders anywhere

#### Scenario: Wire bytes and schema bytes disagree

- GIVEN OxideGate wire bytes and mcp-savings schema bytes differ
- WHEN lens renders both
- THEN both render separately and labeled, never merged into one number

### Requirement: Unmeasurable is not zero — test the `ok` flag, not field presence

When `mcpMeasurement[].ok === false`, mcp-savings could not measure that
server: its `bytes` is the sum of an empty tool list — present, typed, numeric,
and meaningless. Lens MUST treat that entry as **price unknown** and MUST
discard its `bytes` value. It MUST surface as "cannot measure" / price unknown,
NEVER as `0`.

The guard MUST test the `ok` flag. A field-presence check on `.bytes` MUST NOT
be relied upon — it does not guard this door.

#### Scenario: Measurement failed, bytes present and zero

- GIVEN an `mcpMeasurement` entry with `ok: false` and `bytes: 0`
- WHEN lens renders that server's price
- THEN it shows "cannot measure" / price unknown, and no `0 B` figure renders

#### Scenario: Field presence does not imply measurement

- GIVEN an `ok: false` entry whose `.bytes` field is present
- WHEN lens applies the snapshot field contract
- THEN presence alone MUST NOT qualify it as a price; the `ok` flag decides

### Requirement: Valve informs; the human declares policy

Lens MUST NEVER change MCP connection policy on its own judgment. A
recommendation MUST NEVER feed `disableMcpServersByDefault` or its allowlist:
every input to that policy MUST originate from the user's declared
configuration (`OXIDEGATE_MCP_DISABLE_BY_DEFAULT`, `OXIDEGATE_MCP_ALLOWLIST`),
never from a valve row.

Applying the user's declared default-off policy at plugin load is REQUIRED
behavior and MUST be preserved: servers the user marked start closed and open on
demand. That is the user's policy applied, not autonomous action.

#### Scenario: Candidate label triggers no policy change

- GIVEN a server is labeled "candidate to disable"
- WHEN lens renders that label
- THEN no disconnect call and no config mutation occurs as a result of the label

#### Scenario: Declared default-off policy still applies

- GIVEN the user set `OXIDEGATE_MCP_DISABLE_BY_DEFAULT` with an allowlist
- WHEN the plugin loads
- THEN non-allowlisted servers start disabled, and this is NOT a violation of
  the informs-only invariant

#### Scenario: Recommendation never reaches the allowlist

- GIVEN any set of valve rows, including "candidate to disable" rows
- WHEN `disableMcpServersByDefault` computes which servers to close
- THEN its inputs are `process.env` and `client.mcp.status()` only; no valve row
  is read

### Requirement: Degradation matrix — full standalone operation

Lens MUST remain functional across every combination; the snapshot is
always optional.

| OxideGate | Snapshot | Behavior |
|---|---|---|
| present | fresh | Full: price + usage + recommendation |
| present | stale | Usage + recommendation + price labeled stale |
| present | missing/malformed | Usage + recommendation, no price; install hint shown |
| absent | fresh | Price shown; no usage/recommendation (existing wire-only mode) |
| absent | stale/missing | No price or usage; UI still renders, no crash |

#### Scenario: Both sources absent

- GIVEN OxideGate is unreachable and the snapshot file is missing
- WHEN lens renders the valve surface
- THEN it renders without price or usage data and does not throw

#### Scenario: OxideGate present, snapshot missing

- GIVEN OxideGate responds normally and the snapshot file does not exist
- WHEN lens renders the valve surface
- THEN usage/toggle work as today, and a one-line hint invites installing
  mcp-savings

## Revision record

Where a ruling reversed earlier spec text, the earlier position is kept here so
the distinction is inherited rather than lost.

| # | Was | Now | Why |
|---|---|---|---|
| **1** | No requirement covered unattributable wire spend; such rows had no defined home. | `unknown` row REQUIRED; observed spend never dropped. Recommendation now REQUIRES a known price; no spend + no price → silence. | The wire is the authority on spend. A dropped row deletes evidence; an `unknown` row makes a broken join visible to a human. Complements `joinHealth`. |
| **2** | "REQUIRED: `.bytes`" checked by field presence. | `ok: false` → price unknown, `bytes` discarded. The guard MUST test the `ok` flag. Bytes and tokens unified under ONE honesty invariant. | `ok: false` ships a present, typed, meaningless `0`. Field-presence checking waves it through. An absent measurement is never a zero measurement. |
| **3** | "Valve informs and recommends, never acts"; auto-disable listed as out of scope wholesale. | "Valve informs; the human declares policy." Forbidden = **autonomous policy change**. Applying the user's declared default-off policy is REQUIRED behavior. | Corrects a framing error: the blanket rule condemned `disableMcpServersByDefault`, an intentional shipped feature. The valve is a tap — starting closed is the user's policy applied, not lens deciding. |
