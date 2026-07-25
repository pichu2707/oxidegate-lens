// lib/mcp-protection.mjs
//
// CONTRACT
// --------
// Which MCP servers the user has declared OFF-LIMITS to the disable-by-
// default pass. Pure function of two inputs — the bytes of a config file and
// an environment object — with no other I/O and no ambient `process.env`
// read, so every branch is reachable from a test without mutating global
// process state.
//
// Exports:
//   readProtectedServers({ path?, env? })  -> ProtectionResult
//   readDisableByDefault({ path?, env? })  -> SwitchResult
//   planMcpDisable({ servers, protection }) -> Plan
//   resolveProtectionConfigPath() -> string
//
// ProtectionResult is one of:
//   { status: 'known', servers: string[], source: 'env' | 'file' | 'default' }
//   { status: 'unknown', reason: 'malformed-json' | 'unrecognized-shape'
//                                | 'unreadable', source: 'file' }
//
// SwitchResult is one of:
//   { status: 'known', enabled: boolean, source: 'env' | 'file' | 'default' }
//   { status: 'unknown', reason, source: 'file' }
//
// Config file shape (`~/.config/oxidegate-lens/config.json`) — the SWITCH and
// the LIST it governs live in ONE place, on purpose:
//   {
//     "disableByDefault": true,
//     "protectedMcpServers": ["engram", "context7"]
//   }
//
// Splitting them was a real defect, not a stylistic one: the switch used to
// live only in `OXIDEGATE_MCP_DISABLE_BY_DEFAULT` while the list lived here,
// and the author of the feature launched OpenCode without exporting it — with
// the instructions in front of him — so the whole thing silently never ran.
// Two mechanisms for one feature is one too many. Both env vars still win
// when defined, so nothing already configured breaks.
//
// THE INVARIANT, AND WHY IT POINTS THE OTHER WAY HERE
// ---------------------------------------------------
// Everywhere else in this repo an absent measurement is never a zero. This
// module is the same rule with teeth, because here the "zero" is not a
// number on a report — it is an INSTRUCTION.
//
//   An empty protected list means "disconnect everything".
//
// So a reader that quietly degrades a broken config into `[]` does not
// produce a slightly-wrong report. It disconnects the exact servers the user
// wrote that config to protect. That is why an unparseable file returns
// `status: 'unknown'` and carries NO `servers` array at all: there must be
// nothing for a careless caller to iterate. `disableMcpServersByDefault` is
// required to disconnect NOTHING when it sees `unknown` — refusing to act is
// the only safe response to not knowing what was protected.
//
// The distinction is load-bearing and easy to erase, so it is pinned by a
// deliberate pair in the tests: `absent_config_is_a_known_empty_list` and
// `malformed_json_is_unknown_not_an_empty_allowlist`. Both end with no usable
// list; only one of them is a fact. A file that does not exist is a user who
// never asked for protection — genuinely, knowably, nothing protected. A file
// that exists and cannot be read is a user who asked for something we cannot
// make out.
//
// WHY A NON-STRING ENTRY POISONS THE WHOLE LIST
// ----------------------------------------------
// `["engram", 42, "context7"]` could be filtered down to the two strings.
// It is not. A filtered list looks complete to the caller, which has no way
// to tell it apart from an intact one — and the dropped entry is, again,
// a server that then gets disconnected. Partial protection is worse than
// admitted ignorance, so the whole result becomes `unknown`.
//
// PRECEDENCE
// ----------
// `OXIDEGATE_MCP_ALLOWLIST` beats the file whenever it is DEFINED — including
// when it is defined and empty. Defined-but-empty is an explicit "protect
// nothing this run", not an absent answer; without that rule there would be
// no way to override a config file from the command line. Because the env
// answer is complete on its own, the file is never read when it wins, so a
// broken config cannot poison a run that did not need it.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The env var that has always carried this list. Kept, not renamed. */
const ALLOWLIST_ENV = 'OXIDEGATE_MCP_ALLOWLIST';

/** The key inside the config file. */
const CONFIG_KEY = 'protectedMcpServers';

/** The switch, and the env var that has always carried it. Kept, not renamed. */
const SWITCH_KEY = 'disableByDefault';
const SWITCH_ENV = 'OXIDEGATE_MCP_DISABLE_BY_DEFAULT';

/**
 * Duplicated by value from nothing — this is the path this repo owns. Kept
 * as a function (not a constant) so `homedir()` is read at call time, which
 * is what lets a test point `$HOME` somewhere else.
 */
export function resolveProtectionConfigPath() {
  return join(homedir(), '.config', 'oxidegate-lens', 'config.json');
}

/**
 * @param {{ path?: string, env?: Record<string, string | undefined> }} opts
 * @returns {{ status: 'known', servers: string[], source: 'env'|'file'|'default' }
 *          | { status: 'unknown', reason: string, source: 'file' }}
 */
export function readProtectedServers({ path = resolveProtectionConfigPath(), env = process.env } = {}) {
  // `in`, not truthiness: an empty string is a real answer here, and `??`
  // or `||` would both throw it away and fall through to the file.
  if (ALLOWLIST_ENV in env && env[ALLOWLIST_ENV] !== undefined) {
    return {
      status: 'known',
      servers: String(env[ALLOWLIST_ENV])
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      source: 'env',
    };
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // A file that is not there is a user who never asked for protection —
    // knowably nothing protected. Any OTHER read failure (permissions, a
    // directory where a file should be) is a file we cannot make out, which
    // is the dangerous case, not the empty one.
    if (error && error.code === 'ENOENT') {
      return { status: 'known', servers: [], source: 'default' };
    }
    return { status: 'unknown', reason: 'unreadable', source: 'file' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unknown', reason: 'malformed-json', source: 'file' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unknown', reason: 'unrecognized-shape', source: 'file' };
  }

  // A config file that exists but says nothing about MCP protection is a
  // user who configured something else. That IS a known empty list.
  if (!(CONFIG_KEY in parsed)) {
    return { status: 'known', servers: [], source: 'file' };
  }

  const declared = parsed[CONFIG_KEY];
  if (!Array.isArray(declared)) {
    return { status: 'unknown', reason: 'unrecognized-shape', source: 'file' };
  }
  if (!declared.every((entry) => typeof entry === 'string')) {
    // See "WHY A NON-STRING ENTRY POISONS THE WHOLE LIST" above. Do not
    // "fix" this into a filter.
    return { status: 'unknown', reason: 'unrecognized-shape', source: 'file' };
  }

  return {
    status: 'known',
    servers: declared.map((entry) => entry.trim()).filter(Boolean),
    source: 'file',
  };
}

/**
 * Reads the disable-by-default SWITCH, from the same file as the list it
 * governs.
 *
 * @param {{ path?: string, env?: Record<string, string | undefined> }} opts
 * @returns {{ status: 'known', enabled: boolean, source: 'env'|'file'|'default' }
 *          | { status: 'unknown', reason: string, source: 'file' }}
 *
 * WHY IT MOVED OUT OF THE ENVIRONMENT
 * -------------------------------------
 * It used to live only in `OXIDEGATE_MCP_DISABLE_BY_DEFAULT`, and that failed
 * a real test: the author of the feature launched OpenCode without exporting
 * it — instructions in hand — so the whole thing silently never ran. A switch
 * you must remember to export before starting a process is a switch that is
 * off most of the time, and one that gives no hint it is off.
 *
 * It also left the configuration incoherent: the protected LIST lived in
 * `config.json` while the SWITCH that consumes it lived in an environment
 * variable. Two mechanisms to learn, for one feature.
 *
 * The env var still WINS when defined, in both directions — an override that
 * can only turn things on is not an override. `OXIDEGATE_MCP_DISABLE_BY_DEFAULT=0`
 * against a file that says `true` yields off.
 *
 * A non-boolean value is `unknown`, never coerced: `Boolean('sí')` is `true`,
 * so a coercing reader would start disconnecting servers because someone
 * wrote the value in Spanish. And `unknown` must never be read as ON — the
 * caller does nothing, which is the same discipline `planMcpDisable` applies
 * to an unreadable protection list.
 */
export function readDisableByDefault({ path = resolveProtectionConfigPath(), env = process.env } = {}) {
  if (SWITCH_ENV in env && env[SWITCH_ENV] !== undefined) {
    const value = String(env[SWITCH_ENV]).trim().toLowerCase();
    return {
      status: 'known',
      enabled: value === '1' || value === 'true' || value === 'yes' || value === 'on',
      source: 'env',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { status: 'known', enabled: false, source: 'default' };
    }
    return { status: 'unknown', reason: error instanceof SyntaxError ? 'malformed-json' : 'unreadable', source: 'file' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unknown', reason: 'unrecognized-shape', source: 'file' };
  }
  if (!(SWITCH_KEY in parsed)) {
    return { status: 'known', enabled: false, source: 'default' };
  }
  if (typeof parsed[SWITCH_KEY] !== 'boolean') {
    return { status: 'unknown', reason: 'unrecognized-shape', source: 'file' };
  }
  return { status: 'known', enabled: parsed[SWITCH_KEY], source: 'file' };
}

/**
 * Decides what the disable-by-default pass may touch.
 *
 * @param {{ servers: string[], protection: object }} input
 * @returns {{ action: 'refuse', reason: 'protection-unknown', protectionReason: string }
 *          | { action: 'disable', targets: string[], preserved: string[], unmatchedProtections: string[] }
 *          | { action: 'nothing-to-do', preserved: string[], unmatchedProtections: string[] }}
 *
 * REFUSING IS THE SAFE ACTION, AND IT IS THE ONLY ONE
 * ----------------------------------------------------
 * When protection is `unknown` this returns `action: 'refuse'` and NO
 * `targets` key at all. Not an empty array — absent. A caller that forgets to
 * check `action` and reaches straight for `targets` gets `undefined`, which
 * throws or iterates nothing; an empty array would let that same caller
 * proceed happily, having "disconnected everything not protected" while
 * knowing nothing about what was protected. The shape is doing safety work
 * that a comment could not.
 *
 * `unmatchedProtections` names servers the user protected that are not in the
 * live list. That is NOT an error — a protected server may simply be off
 * right now — but it is also exactly what a typo looks like, and the user
 * believes they protected something. Reporting it is the difference between
 * a config that works and one that only looks like it does.
 */
export function planMcpDisable({ servers, protection }) {
  if (!protection || protection.status !== 'known') {
    return {
      action: 'refuse',
      reason: 'protection-unknown',
      protectionReason: protection?.reason ?? 'unknown',
    };
  }

  const protectedSet = new Set(protection.servers);
  const live = Array.isArray(servers) ? servers : [];

  const preserved = live.filter((server) => protectedSet.has(server));
  const targets = live.filter((server) => !protectedSet.has(server));
  const unmatchedProtections = protection.servers.filter((name) => !live.includes(name));

  if (targets.length === 0) {
    return { action: 'nothing-to-do', preserved, unmatchedProtections };
  }
  return { action: 'disable', targets, preserved, unmatchedProtections };
}
