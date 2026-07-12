// lib/mcp-config.mjs
//
// CONTRACT
// --------
// Reads the MCP servers the user has DECLARED — configured, whether or not
// they show up on the wire for any given request — independently of
// whatever `oxidegate-savings.mjs` observes in `tools_by_server`. This is
// the "declared" side of the declared-vs-arrived comparison that
// `docs/optimizer-tool-search.md` §3.4/§9 in OxideGate calls out as the one
// thing a proxy-side lens structurally cannot do on its own: a proxy sees
// only what a client decided to send, never what the client has configured
// but chose to withhold. `oxidegate-lens` runs on the user's own machine,
// so it CAN read that other side.
//
// Exports:
//   readDeclaredMcpServers({ timeoutMs }) -> Promise<DeclaredMcpConfig>
//   sanitizeServerName(name) -> string
//
// DeclaredMcpConfig is one of:
//   { status: 'known', servers: [{ name, connected }] }   — including [].
//   { status: 'unknown', reason: 'claude-not-found' | 'timeout' |
//                                  'command-failed' | 'unparseable',
//     detail?: string }
//
// SOURCE CHOICE, AND WHY
// -----------------------
// Two candidate sources exist on disk/PATH: `claude mcp list` (spawned as a
// child process) and `~/.claude.json` (read and JSON-parsed directly). This
// module uses `claude mcp list`. Reasons:
//
//   - `claude mcp list` is Claude Code's OWN resolution of "which servers
//     apply here". It already folds together user-level config, per-project
//     config, and a project's `.mcp.json`, resolved for the CURRENT working
//     directory. Reimplementing that scope-merge by hand-parsing
//     `~/.claude.json` would mean tracking undocumented, version-dependent
//     merge logic — a second, worse copy of the same bug this whole change
//     exists to fix one level up (see the `client_defer_loading` deletion
//     this project just went through: reasoning from an internal signal
//     that looked stable and was not).
//   - The line format below (`name: command/url - <status>`) is stable
//     CLI-facing output, not an internal data structure Anthropic reserves
//     the right to change without notice the way it does for `.claude.json`.
//   - The cost is real and is accepted deliberately: spawning a process is
//     slower than reading a file, and requires the `claude` binary on PATH.
//     Both failure modes are handled below as UNKNOWN, never as zero — see
//     FAILURE POLICY.
//
// FAILURE POLICY — "I don't know" must never render as "zero"
// ---------------------------------------------------------------
// This is the entire reason this module exists. Collapsing "could not read
// the declared config" into "the config says zero servers" would reproduce,
// one layer up, the exact defect seven review rounds already fought in
// OxideGate: a report that states more than it knows.
//
//   - `claude` not on PATH / ENOENT           -> unknown, 'claude-not-found'
//   - spawns but times out                    -> unknown, 'timeout'
//   - spawns, exits non-zero                  -> unknown, 'command-failed'
//   - exits zero, output doesn't match the
//     expected shape at all                   -> unknown, 'unparseable'
//   - exits zero, output parses, ZERO servers -> known, servers: []
//     (a KNOWN zero — categorically different from any line above)
//   - exits zero, output parses, N servers    -> known, servers: [...]
//
// A single line this module cannot parse fails the WHOLE read as
// 'unparseable' rather than silently dropping that one server: an
// undercount of declared servers would turn a real "harness is withholding
// server X" finding into a false "nothing withheld", which is the failure
// mode this module is not allowed to have.
//
// NAME NORMALIZATION
// -------------------
// Tool names on the wire follow `mcp__<server>__<tool>`
// (`group_tools_by_server` in OxideGate's `src/provider/mod.rs`). Claude
// Code builds `<server>` from the declared server name by replacing every
// character that is not `[A-Za-z0-9_]` with `_`. Confirmed against two
// independent, already-recorded examples (OxideGate's
// `docs/optimizer-tool-search.md` and this project's own README):
//   "claude.ai Gmail"       -> "claude_ai_Gmail"
//   "plugin:engram:engram"  -> "plugin_engram_engram"
// `claude mcp list` prints the ORIGINAL name, so it has to go through the
// same transform before it can be compared against a
// `tools_by_server[].server` value. `sanitizeServerName` does exactly that
// transform and nothing else — it is not a general slugifier.

import { spawn } from 'node:child_process';

// `claude mcp list` checks the health of every configured server before it
// prints anything ("Checking MCP server health…"), so this is a real
// round-trip per server, not a local config read. Generous on purpose: this
// module is invoked once per `oxidegate-savings` run by a human who already
// accepted a 2s wait for a single localhost fetch elsewhere in this repo.
const DEFAULT_TIMEOUT_MS = 15_000;

// Why `spawn` + resolve-on-`exit`, not `execFile`/`promisify`:
// `execFile`'s promise settles on the child's `close` event, which Node only
// fires once the child's stdio STREAMS end — not once the child process
// itself exits. An MCP server entry can spawn a detached grandchild that
// inherits our stdout fd; `claude` itself exits immediately, but that
// grandchild can keep the fd open indefinitely, so `close` never fires and
// the promise hangs until `timeoutMs` regardless of how fast `claude` was.
// Reproduced with a fixture: the call took the full 15s default and only
// THEN resolved with otherwise-correct data. `exit` fires as soon as the
// process we actually spawned terminates, independent of who else still
// holds the fd — that's the signal we want.
function runClaudeMcpList(timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('claude', ['mcp', 'list']);
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const err = new Error('claude mcp list timed out');
      err.killed = true;
      reject(err);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        const err = new Error(`claude mcp list was killed by signal ${signal}`);
        reject(err);
        return;
      }
      if (code !== 0) {
        const err = new Error(`claude mcp list exited with code ${code}: ${stderr.trim()}`);
        err.code = code;
        reject(err);
        return;
      }
      resolve({ stdout });
    });
  });
}

const HEADER_RE = /^Checking MCP server health/i;
const EMPTY_RE = /^No MCP servers (?:configured|found)/i;

export function sanitizeServerName(name) {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Parses `claude mcp list` stdout into `{ name, connected }` entries.
 * Returns `null` (never throws) if the output does not match the expected
 * shape closely enough to trust — see FAILURE POLICY above for why that
 * is a hard "unknown", not a best-effort partial parse.
 */
function parseMcpListOutput(stdout) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !HEADER_RE.test(line));

  if (lines.length === 0) return { servers: [] };
  if (lines.length === 1 && EMPTY_RE.test(lines[0])) return { servers: [] };

  const servers = [];
  for (const line of lines) {
    // Server names may contain ':' (e.g. "plugin:engram:engram"), so we
    // cannot split on the first ':'. They should never contain the
    // two-character sequence ": " (colon-space), which is what actually
    // separates the name from the command/url. If a line breaks this
    // assumption, that is exactly the kind of surprise FAILURE POLICY says
    // to treat as 'unparseable' for the whole read, not paper over.
    const nameSep = line.indexOf(': ');
    if (nameSep === -1) return null;

    // A hand-edited `.mcp.json` bypasses `claude mcp add`'s name validation,
    // so a server can be declared with ': ' INSIDE its own name (measured:
    // a project `.mcp.json` naming a server "evil: server - trap" makes
    // `claude mcp list` print `evil: server - trap: node ... - ⏸ Pending...`).
    // `indexOf` alone always picks the FIRST ': ', silently truncating the
    // name to "evil" and treating the rest of the name as if it were the
    // command. If a SECOND ': ' exists anywhere after the first, we cannot
    // tell which one is the real name/command separator — that is exactly
    // the assumption-break FAILURE POLICY says fails the WHOLE read, not
    // just this line.
    if (line.indexOf(': ', nameSep + 1) !== -1) return null;

    const name = line.slice(0, nameSep);
    const rest = line.slice(nameSep + 2);

    // "<command-or-url> - <status-symbol> <status-text>" — split on the
    // LAST " - " so a command containing " - " (unlikely, but not
    // impossible) does not break the split.
    const statusSep = rest.lastIndexOf(' - ');
    if (statusSep === -1) return null;
    const statusText = rest.slice(statusSep + 3);
    if (statusText.length === 0) return null;

    servers.push({ name, connected: statusText.startsWith('✔') });
  }
  return { servers };
}

/**
 * Reads the MCP servers declared for the current user/project by shelling
 * out to `claude mcp list`. See FAILURE POLICY above for the full
 * unknown-vs-zero contract this function guarantees.
 */
export async function readDeclaredMcpServers({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let stdout;
  try {
    ({ stdout } = await runClaudeMcpList(timeoutMs));
  } catch (err) {
    if (err && err.killed) return { status: 'unknown', reason: 'timeout' };
    if (err && (err.code === 'ENOENT' || err.errno === -2)) {
      return { status: 'unknown', reason: 'claude-not-found' };
    }
    return { status: 'unknown', reason: 'command-failed', detail: err?.message };
  }

  const parsed = parseMcpListOutput(stdout ?? '');
  if (parsed === null) return { status: 'unknown', reason: 'unparseable' };
  return { status: 'known', servers: parsed.servers };
}
