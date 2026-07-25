// lib/mcp-transitions.mjs
//
// CONTRACT
// --------
// Turns two `client.mcp.status` readings into "what changed". Pure functions
// of their arguments — no clock, no I/O, no SDK.
//
// Exports:
//   diffMcpStatus(previous, current) -> DiffResult
//   partitionByConnected(status) -> { status: 'known', connected, notConnected }
//                                 | { status: 'unreadable' }
//
// DiffResult is one of:
//   { status: 'baseline',   connected: [], disconnected: [], appeared: [], vanished: [] }
//   { status: 'unreadable', connected: [], disconnected: [], appeared: [], vanished: [] }
//   { status: 'compared',
//     connected: string[],                       // observed reaching connected
//     disconnected: string[],                    // observed leaving connected
//     appeared: [{ name, connected: boolean }],  // not in the previous reading
//     vanished: string[] }                       // gone from the current one
//
// WHY THIS MODULE EXISTS AT ALL
// ------------------------------
// OpenCode emits NO MCP event. The `Event` union in @opencode-ai/sdk has 32
// members — session, message, LSP, PTY, file, permission, TUI, server — and
// not one of them is MCP-shaped. Checked by grep against the installed
// `types.gen.d.ts`, not assumed. So "a server connected" is not something we
// can subscribe to; it can only be learned by reading the status twice and
// comparing. Every design choice below follows from that.
//
// THE FIRST READING IS A BASELINE, NOT A WAVE OF CONNECTIONS
// -----------------------------------------------------------
// Diffing against "nothing" trivially makes every connected server look like
// it just connected. That would fire a burst of false notices on every single
// startup, which is precisely the noise that teaches a user to ignore the
// feature — and a notifier nobody reads is worse than none, because it also
// costs a poll. `previous === undefined` therefore returns `status:
// 'baseline'` with every list empty. Not "no changes"; "no comparison".
//
// WHY THE COMPARISON IS AGAINST 'connected' AND NOTHING ELSE
// -----------------------------------------------------------
// The live SDK returns **`"disabled"`**, not `"disconnected"`, after
// `client.mcp.disconnect` — confirmed against a running OpenCode 1.18.4, not
// read off a type. A module that compared against a list of known "off" words
// would have missed that one silently. So there is exactly one string with
// meaning here, `'connected'`, and EVERYTHING else is treated as not
// connected, including words that do not exist yet.
//
// That direction is deliberate. An unrecognised word could be read either
// way, and the two mistakes are not symmetric: guessing "still connected"
// stays SILENT about a server that really went down, while guessing "not
// connected" raises a false alarm the user can see and dismiss. A false alarm
// beats silence about a real outage. Do not "improve" this into a
// known-status allowlist.
//
// APPEARED IS NOT CONNECTED, VANISHED IS NOT DISCONNECTED
// --------------------------------------------------------
// A server absent from the previous reading did not transition — we never
// watched it. It might have connected a second ago or an hour ago; claiming
// the former is inventing an observation. Same on the way out: a server that
// drops out of the reading was removed from configuration, which is a
// different fact from being turned off, and collapsing the two would report
// a config edit as an outage.

/** The one status string confirmed against a live SDK. See header. */
const CONNECTED = 'connected';

const EMPTY = () => ({ connected: [], disconnected: [], appeared: [], vanished: [] });

/**
 * A usable reading is a plain object whose values are objects. Anything else
 * — null, an array, a string, entries that are not objects — is unreadable,
 * never coerced into "no servers".
 */
function readEntries(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const entries = Object.entries(status);
  if (entries.some(([, value]) => !value || typeof value !== 'object' || Array.isArray(value))) return null;
  return entries;
}

function isConnected(entry) {
  return entry?.status === CONNECTED;
}

/**
 * @param {unknown} previous  the last reading, or undefined on first sight
 * @param {unknown} current   the reading just taken
 */
export function diffMcpStatus(previous, current) {
  const currentEntries = readEntries(current);
  if (currentEntries === null) return { status: 'unreadable', ...EMPTY() };

  // No previous reading is not "nothing was connected". It is "we had not
  // looked". See the header.
  if (previous === undefined || previous === null) {
    return { status: 'baseline', ...EMPTY() };
  }
  const previousEntries = readEntries(previous);
  if (previousEntries === null) return { status: 'unreadable', ...EMPTY() };

  const before = new Map(previousEntries);
  const after = new Map(currentEntries);

  const connected = [];
  const disconnected = [];
  const appeared = [];
  const vanished = [];

  for (const [name, entry] of after) {
    if (!before.has(name)) {
      appeared.push({ name, connected: isConnected(entry) });
      continue;
    }
    const wasConnected = isConnected(before.get(name));
    const nowConnected = isConnected(entry);
    if (!wasConnected && nowConnected) connected.push(name);
    else if (wasConnected && !nowConnected) disconnected.push(name);
  }

  for (const [name] of before) {
    if (!after.has(name)) vanished.push(name);
  }

  return { status: 'compared', connected, disconnected, appeared, vanished };
}

/**
 * Splits a single reading for the startup notice. Returns NEITHER list when
 * the reading is unusable — two empty arrays would render as "0 connected,
 * 0 disconnected", a confident statement about something we could not read.
 */
export function partitionByConnected(status) {
  const entries = readEntries(status);
  if (entries === null) return { status: 'unreadable' };

  const connected = [];
  const notConnected = [];
  for (const [name, entry] of entries) {
    (isConnected(entry) ? connected : notConnected).push(name);
  }
  return { status: 'known', connected, notConnected };
}
