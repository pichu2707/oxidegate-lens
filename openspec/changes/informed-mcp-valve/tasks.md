# Tasks: Informed MCP Valve

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | PR1 (lens, this repo) ~1000-1500 across 3 new lib modules + tests + CLI/plugin wiring; PR2/PR3 (mcp-savings) out of this repo |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → 4 stacked slices (1a-1d) in lens; PR2, PR3 in mcp-savings (separate change) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — user decision needed |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|---|---|---|---|
| 1a | `lib/mcp-snapshot.mjs` + tests | PR 1a | Additive, unused until 1d — safe standalone |
| 1b | `lib/mcp-usage.mjs` + tests | PR 1b | Additive, independent of 1a |
| 1c | `lib/mcp-valve.mjs` + tests + topology guard | PR 1c | Uses 1a/1b exports; not wired at runtime yet |
| 1d | CLI section (d) + plugin tool graduation + comment fix + CLI-level tests | PR 1d | Only slice changing user-visible output; base = 1c branch |
| 2 | mcp-savings: atomic `saveSnapshot` | separate change | Not a lens prerequisite |
| 3 | mcp-savings: retire panel, keep `/saving` | separate change | Merge gate: PR1d live + confirmed in a session |

If `feature-branch-chain`: 1a bases on tracker; 1b/1c/1d each base on the prior slice's branch.

## Phase 1: `lib/mcp-snapshot.mjs` (PR 1a)

- [x] 1.1 RED — `test/mcp-snapshot.test.mjs`: missing file, malformed/torn JSON, entry missing `bytes`, **`ok:false`+`bytes:0` → price `unknown`**, **`ok:true`+`bytes:0` → known `0`** (load-bearing pair proving the guard reads `ok`, not presence), `tokens:null` passthrough, fresh vs 30h-stale (24h threshold).
- [x] 1.2 GREEN — implement `readMcpSavingsSnapshot({path?, now?})`, `resolveSnapshotPath()`. CONTRACT header states the honesty invariant verbatim + why `ok` not `.bytes` is tested. `resolveSnapshotPath` duplicates `mcp-savings/config.ts::snapshotPath()` by value, no import.

## Phase 2: `lib/mcp-usage.mjs` (PR 1b)

- [x] 2.1 RED — `test/mcp-usage.test.mjs`: window = newest−oldest; gate refuses at 29min/4 requests, passes at 30min/5; `(others)` flag; rows with absent `tools_by_server` excluded, empty array included; unparseable RFC 3339 row dropped.
- [x] 2.2 GREEN — implement `observeMcpUsage(requests, {now?})`. Declare `MIN_WINDOW_MS` (30 min) and `MIN_REQUEST_COUNT` (5) as **named constants with a comment stating they are judgment calls, not measured thresholds**.

## Phase 3: `lib/mcp-valve.mjs` (PR 1c)

- [ ] 3.1 RED — `test/mcp-valve.test.mjs`: exact match, sanitized match, collision→`ambiguous`, snapshot-only, **wire-only spend → `unknown` row, never dropped**, **no spend + no price → silence**, `joinHealth:'no-correspondence'` suppresses fleet-wide, `already-off` branch, every named refusal reason.
- [ ] 3.2 GREEN — implement `buildValveRows({snapshot, usage})`: FULL OUTER JOIN, `joinHealth`, recommendation conjunction. CONTRACT header carries Decision 6 in full (mismatch/0-uses identity, why `unknown` exists).
- [ ] 3.3 RED — `test/mcp-valve-topology.test.mjs`: static assert `lib/mcp-valve.mjs` and its transitive imports contain no reference to `client.mcp.connect`/`disconnect`/`.status` (Decision 8's firewall as a test, not a header comment).
- [ ] 3.4 GREEN — confirm module imports only `mcp-snapshot.mjs`, `mcp-usage.mjs`, `sanitizeServerName`; no `client` parameter anywhere in its exported signatures.

## Phase 4: Wiring (PR 1d)

- [ ] 4.1 RED — extend `test/oxidegate-savings.test.mjs` + `test/helpers/run-savings-cli.mjs` (new `homePath` option, new `test/helpers/fake-snapshot.mjs`) across the 5-row degradation matrix; add `assertNoDroppedSpend` alongside existing `assertNoUnwindowedRecommendation`/`assertNoFabricatedZero`.
- [ ] 4.2 GREEN — wire the three `lib/` modules into `bin/oxidegate-savings.mjs` section (d). Render the `unknown` row **conspicuously**: its own labeled block adjacent to, but visually distinct from, the per-server table — never a quiet footnote.
- [ ] 4.3 GREEN — every `candidate to disable` / `0 uses` string MUST carry its observation window in the same sentence; add a render-level assert forbidding a bare `0 uses` or bare `candidate to disable` substring in stdout.
- [ ] 4.4 GREEN — `opencode/oxidegate-lens.ts`: rename `oxidegate_lens_experimental_mcp_status/_connect/_disconnect` → `oxidegate_lens_mcp_valve/_connect/_disconnect`; `mcp_valve` returns price+usage+window+recommendation+reason via `buildValveRows`; `valveResult`'s `experiment:` key → `caveat:`, `warning` string preserved verbatim.
- [ ] 4.5 GREEN — delete the outdated "WHAT THIS PLUGIN DOES NOT DO" routing claim (`opencode/oxidegate-lens.ts` header, lines ~11-18); replace with a note that a fetch-patch plugin already routes OpenCode traffic through OxideGate today, and that routing itself stays out of this change's scope.
- [ ] 4.6 Verify (no code change) — `resolveBaseUrl()` (`OXIDEGATE_LENS_URL` → `OXIDEGATE_PORT` → `8080`) already works for non-default ports; do not hardcode any port in new code.
- [ ] 4.7 Full suite — `node --test test/*.test.mjs` green: 25 existing + all new tests, zero regressions.

## Phase 5: Cross-repo follow-up (mcp-savings — separate change, not executed here)

- [ ] 5.1 `saveSnapshot` → `writeFileSync(tmp)` + `rename` (atomic write).
- [ ] 5.2 Retire `packages/opencode/src/panel.ts` sidebar (`Panel`, `computeRows`, `renderRow`, `PanelRow`, `api.slots.register`, unused `@opentui/solid`/`solid-js` imports); rename file to `tui.ts`, keep only `registerReportCommand`. Merge gate: PR1d published and confirmed live in a session.
