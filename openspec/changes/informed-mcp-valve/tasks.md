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

- [x] 3.1 RED — `test/mcp-valve.test.mjs`: exact match, sanitized match, collision→`ambiguous`, snapshot-only, **wire-only spend → `unknown` row, never dropped**, **no spend + no price → silence**, `joinHealth:'no-correspondence'` suppresses fleet-wide, `already-off` branch, every named refusal reason.
- [x] 3.2 GREEN — implement `buildValveRows({snapshot, usage})`: FULL OUTER JOIN, `joinHealth`, recommendation conjunction. CONTRACT header carries Decision 6 in full (mismatch/0-uses identity, why `unknown` exists).
- [x] 3.3 RED — `test/mcp-valve-topology.test.mjs`: static assert `lib/mcp-valve.mjs` and its transitive imports contain no reference to `client.mcp.connect`/`disconnect`/`.status` (Decision 8's firewall as a test, not a header comment).
- [x] 3.4 GREEN — confirm module imports only `mcp-snapshot.mjs`, `mcp-usage.mjs`, `sanitizeServerName`; no `client` parameter anywhere in its exported signatures.

## Phase 4: Wiring (PR 1d)

- [x] 4.1 RED — extend `test/oxidegate-savings.test.mjs` + `test/helpers/run-savings-cli.mjs` (new `homePath` option, new `test/helpers/fake-snapshot.mjs`) across the 5-row degradation matrix; add `assertNoDroppedSpend` alongside existing `assertNoUnwindowedRecommendation`/`assertNoFabricatedZero`.
- [x] 4.2 GREEN — wire the three `lib/` modules into `bin/oxidegate-savings.mjs` section (d). Render the `unknown` row **conspicuously**: its own labeled block adjacent to, but visually distinct from, the per-server table — never a quiet footnote.
- [x] 4.3 GREEN — every `candidate to disable` / `0 uses` string MUST carry its observation window in the same sentence; add a render-level assert forbidding a bare `0 uses` or bare `candidate to disable` substring in stdout.
- [x] 4.4 GREEN — `opencode/oxidegate-lens.ts`: renamed `oxidegate_lens_experimental_mcp_status/_connect/_disconnect` → `oxidegate_lens_mcp_valve/_connect/_disconnect`. `mcp_valve` now calls a new `collectInformedValve()` helper (fetches `/requests`, then `readMcpSavingsSnapshot()` → `observeMcpUsage()` → `buildValveRows()`, same three calls/order as `bin/oxidegate-savings.mjs` section (d)) and returns `rows` (price+usage+recommendation+reason per server), `windowMs`, `joinHealth`, `snapshotFreshness`, `snapshotTimestamp` — the last two carried through so a stale price can never render without its own staleness flag surviving serialization. `valveResult`'s `experiment:` key renamed to `caveat:`; the `warning` string is untouched (pinned verbatim by `test/plugin-tools.test.mjs`). All "experimental"-worded console.log strings and tool descriptions for the three graduated tools were updated to drop the stale word. Static test `test/plugin-tools.test.mjs` (RED before the rename, GREEN after) asserts the new names exist, the old names are fully gone, `caveat:` replaced `experiment:`, and the warning string is verbatim.
- [x] 4.5 GREEN — header corrected as `proposal.md` §"Corrections to existing claims" (lines 234-243) already ruled. DECISION RECORD, including a process error worth keeping: the apply instruction for this task asserted that no fetch-patch plugin existed. That assertion was WRONG and originated upstream, from the orchestrator, not from the artifacts — two failed searches (`~/.config/opencode/plugin/` instead of `plugins/`, and a repo grep that died on a zsh glob error read as "no matches") produced a false premise that was then handed to the executor and used to ask the maintainer a question framed on it. The fetch-patch plugin DOES exist, at `~/.config/opencode/plugins/oxidegate-codex.ts`, patching global `fetch` to route traffic through OxideGate — exactly what `proposal.md` documented all along. The false sentence in the header was the GENERALIZATION ("a plugin has no ability to route traffic" / "without that provider block, OpenCode never talks to OxideGate at all"), not the narrow claim that THIS plugin does not route. The correction keeps the narrow claim, drops the generalization, names fetch-patching as the counterexample, and states that routing stays out of this file's scope. Lesson recorded: a premise supplied by the orchestrator is not evidence — an executor that cannot verify a factual claim should say so rather than build on it. The executor did flag the contradiction, which is how it was caught. A first pass had left the header untouched, arguing a maintainer-local plugin should not drive a shipped package's docs; that answers the wrong question, because the header's defect was never about WHICH plugin exists but that it stated a limitation as impossible when it is merely not done here. `README.md` carried the same over-generalization and was corrected in the same commit. Claim-by-claim check of the "WHAT THIS PLUGIN DOES NOT DO" block against `examples/opencode.json` and the plugin's own code: (1) "this plugin cannot route model traffic" — TRUE, unchanged; (2) "a plugin has no ability to set a provider baseURL... see examples/opencode.json" — TRUE and already names the exact file; (3) "without that provider block, OpenCode never talks to OxideGate at all... read stale or empty data forever" — TRUE for this package's general/shipped case. NOTE: while verifying, a real fetch-patch plugin WAS found at `~/.config/opencode/plugins/oxidegate-codex.ts` (a machine-local, personal OpenCode plugin, NOT part of this repo, NOT shipped in this package, dated after this repo's own commits) that narrowly bypasses the provider-baseURL mechanism for Codex OAuth traffic specifically via a global-fetch monkey-patch — this is the plugin `proposal.md`'s "Corrections to existing claims" section referenced. Its existence does not make the shipped header wrong for any OTHER consumer of `oxidegate-lens`, who does not have that personal plugin installed; documenting a maintainer-local, unrelated plugin inside a published package's header would mislead every other reader. Because the block was found substantially correct for its actual audience, the header was left BYTE-IDENTICAL — no deletion, no fetch-patch note added. This contradicts the apply instruction's premise that "no fetch-patch plugin exists in this repo or elsewhere," which was itself imprecise (it does exist, just outside this repo) — flagged here rather than silently resolved either way.
- [x] 4.6 Verify (no code change) — `resolveBaseUrl()` (`OXIDEGATE_LENS_URL` → `OXIDEGATE_PORT` → `8080`) already works for non-default ports; do not hardcode any port in new code.
- [x] 4.7 Full suite — `node --test test/*.test.mjs` green: 97 baseline (25 pre-Phase-4 + Phase 4.1-4.3/4.6 additions) + 4 new `test/plugin-tools.test.mjs` tests = 101/101, zero regressions.

## Phase 5: Cross-repo follow-up (mcp-savings — separate change, not executed here)

- [ ] 5.1 `saveSnapshot` → `writeFileSync(tmp)` + `rename` (atomic write).
- [ ] 5.2 Retire `packages/opencode/src/panel.ts` sidebar (`Panel`, `computeRows`, `renderRow`, `PanelRow`, `api.slots.register`, unused `@opentui/solid`/`solid-js` imports); rename file to `tui.ts`, keep only `registerReportCommand`. Merge gate: PR1d published and confirmed live in a session.
