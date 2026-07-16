# Informed MCP Valve — Data Contract and Behavior Specification

## Purpose

Defines the data contract lens consumes from `~/.config/mcp-savings/snapshot.json`
and the behavioral rules for the informed valve: defensive parsing,
staleness, the `0 uses` recommendation, the honesty invariant, and
degradation across OxideGate/snapshot availability. Does NOT define file
layout or implementation structure — that is `sdd-design`'s contract.

## Out of Scope

Routing, auto-acting/auto-disable, tokenizer estimation, context-window
percentage, any runtime dependency on `@mcp-savings/core`.

## ADDED Requirements

### Requirement: Snapshot field contract

REQUIRED fields: `timestamp`, `mcpMeasurement[].server`, `.bytes`. All other
fields (`.tokens`, `serverWeights`, `totalSchemaBytes`, `sessionTokens`,
`model`, `host`, `.ok`, `.enabled`) are OPTIONAL. A missing REQUIRED field on
an entry MUST drop that entry's price data only, never the whole snapshot. A
missing OPTIONAL field MUST render as absent, never `0` or invented.

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

### Requirement: `0 uses` recommendation always carries its window

Lens MUST label a server "candidate to disable" only when its tools have 0
occurrences in `tools_by_server` across the observed window, and MUST always
render that window with the label. A bare "0 uses" or bare "candidate to
disable" MUST NEVER appear.

#### Scenario: Zero uses, window stated

- GIVEN server `foo` has 0 entries in `tools_by_server` over a 3h window
- WHEN lens renders `foo`'s recommendation
- THEN it shows "candidate to disable — 0 uses in the last 3h"

#### Scenario: Window is never omitted

- GIVEN any server with 0 observed uses
- WHEN lens renders its recommendation
- THEN the label always includes an explicit window

### Requirement: Honesty invariant — `null` never coerces to zero

Lens MUST distinguish four number qualities without blending them: wire
bytes (measured fact), schema bytes (measured locally, may differ from
wire), exact tokens (OpenAI o200k_base), absent tokens (Claude,
`countTokens` returns `null`). `null` MUST NEVER render as `0`. When tokens
are absent, the headline MUST degrade to bytes.

#### Scenario: Claude model, tokens null

- GIVEN `mcpMeasurement[].tokens` is `null`
- WHEN lens renders the cost headline
- THEN it shows bytes; no `0` tokens figure renders anywhere

#### Scenario: Wire bytes and schema bytes disagree

- GIVEN OxideGate wire bytes and mcp-savings schema bytes differ
- WHEN lens renders both
- THEN both render separately and labeled, never merged into one number

### Requirement: Valve informs and recommends, never acts

Lens MUST render recommendations and toggles without ever invoking
connect/disconnect automatically. Every connection state change MUST
originate from an explicit human action.

#### Scenario: Candidate label triggers no action

- GIVEN a server is labeled "candidate to disable"
- WHEN lens renders that label
- THEN no disconnect call or config mutation occurs as a result

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
