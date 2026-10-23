// lib/mcp-connect-description.mjs
//
// CONTRACT
// --------
// The words of the three MCP tools, as the MODEL reads them. Pure functions of
// already-read facts (a status record and an mcp-savings snapshot) — no I/O.
//
// Exports:
//   buildConnectDescription({ status, snapshot }) -> string
//   DISCONNECT_DESCRIPTION, VALVE_DESCRIPTION     -> string
//
// WHY THE CONNECT DESCRIPTION CARRIES DATA
// ----------------------------------------
// A disconnected server's tools are absent from the request, so the model has
// no way to know a capability exists behind it. This description is the only
// place that can say so; with it the model connects on its own when a task
// needs a server, instead of the user doing it by hand. It is sent on every
// request, so it names tools but carries no schemas, and long lists are cut
// with an honest count.
//
// HONESTY
// -------
// Unknown tool names are said to be unknown ("tools unknown"), never rendered
// as an empty list; a server that declares zero tools says "no tools
// declared". An unreadable status says "status unknown" instead of
// "nothing disconnected". An absent measurement is never a zero measurement.

// This text rides on EVERY request. With ~10 disconnected servers it must stay
// a pointer, not a catalogue: a few tool names per server (enough to tell what
// the server is for) and a hard cap on the whole string.
const MAX_TOOLS_SHOWN = 4;
const MAX_ENTRY_BYTES = 130;
const MAX_TOTAL_BYTES = 1500;

const BASE =
  'Connect a disconnected OpenCode MCP server. Its tools are not available until it is connected, ' +
  'so call this BEFORE you need a capability only that server provides.';

function offered(status) {
  return Object.entries(status)
    .filter(([, entry]) => entry?.status === 'disabled' || entry?.status === 'failed')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function describeTools(name, snapshot) {
  if (snapshot?.status !== 'known') return 'tools unknown';
  const entry = snapshot.servers.find((s) => s.name === name);
  if (!entry || !Array.isArray(entry.toolNames)) return 'tools unknown';
  if (entry.toolNames.length === 0) return 'no tools declared';
  const shown = entry.toolNames.slice(0, MAX_TOOLS_SHOWN).join(', ');
  const rest = entry.toolNames.length - MAX_TOOLS_SHOWN;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * @param {{ status: Record<string, {status: string}> | null, snapshot: object }} input
 */
export function buildConnectDescription({ status, snapshot }) {
  if (!status || typeof status !== 'object') {
    return `${BASE} Current MCP status unknown; pass the server name to try.`;
  }
  const list = offered(status);
  if (list.length === 0) return `${BASE} There are no disconnected servers right now.`;

  const rows = list.map(([name, entry]) => {
    const label = entry.status === 'failed' ? `${name} (failed)` : name;
    return clip(`${label}: ${describeTools(name, snapshot)}`);
  });

  const head = `${BASE} Disconnected now: `;
  const overflow = (n) => ` ...and ${n} more, call oxidegate_lens_mcp_valve to list.`;
  // Add entries in name order while the whole string, including the overflow
  // note it would then need, still fits.
  let shown = 0;
  for (; shown < rows.length; shown++) {
    const body = rows.slice(0, shown + 1).join('; ');
    const remaining = rows.length - (shown + 1);
    const tail = remaining > 0 ? overflow(remaining) : '.';
    if (Buffer.byteLength(head + body + tail) > MAX_TOTAL_BYTES) break;
  }
  const remaining = rows.length - shown;
  return head + rows.slice(0, shown).join('; ') + (remaining > 0 ? overflow(remaining) : '.');
}

function clip(entry) {
  if (Buffer.byteLength(entry) <= MAX_ENTRY_BYTES) return entry;
  return `${Buffer.from(entry).subarray(0, MAX_ENTRY_BYTES - 3).toString('utf8').replace(/\uFFFD$/, '')}...`;
}

export const DISCONNECT_DESCRIPTION =
  'Disconnect one OpenCode MCP server to free context when you no longer need its tools. ' +
  'Reconnect any time with oxidegate_lens_mcp_connect. Reports MCP/tool-list snapshots before and after.';

export const VALVE_DESCRIPTION =
  'Show which OpenCode MCP servers are connected, what each costs per request, and which are candidates to disconnect ' +
  '(candidate-to-disable / already-off / no-recommendation, each with a named reason). ' +
  'Use it to decide what to connect or disconnect with oxidegate_lens_mcp_connect / oxidegate_lens_mcp_disconnect.';
