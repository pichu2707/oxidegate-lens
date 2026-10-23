// lib/opencode-v2.mjs
//
// CONTRACT
// --------
// Pure adapters between OpenCode 2.x's plugin API and the shapes the rest of
// lib/ already speaks. No SDK, no clock, no I/O: the v2 entry
// (`opencode/oxidegate-lens.server.ts`) is TypeScript and cannot run under
// `node --test`, so everything decidable lives here, where the suite can
// execute it.
//
// Exports:
//   mcpListToStatus(list)            -> { [name]: { status, error? } } | null
//   applyMcpOverrides(editor, ov)    -> { applied: string[], missing: string[] }
//   overridesSettled(status, ov)    -> boolean
//   isMcpStatusChangedEvent(event)   -> boolean
//   noticeToLogLine(notice)          -> { level: 'warn' | 'log', text } | null
//   mcpToolInput(kind)               -> JSON Schema for a tool's input
//   V2_DEGRADATIONS                  -> frozen list of what v2 cannot do as v1 did
//   summarizeMcpStatus, valveResult, latestRequestLine, resolveBaseUrl
//                                    -> runtime-neutral helpers the v2 entry
//                                       shares with the v1 wording
//
// WHY A SECOND ENTRY AT ALL
// --------------------------
// OpenCode 2.x replaced the plugin contract: a plugin must default-export a
// definition `{ id, setup(ctx) }` (the v1 named-export function is rejected
// with "Plugin must export a default definition with an id and an effect or
// setup function"), and the `client` SDK handed to v1 plugins is gone. The v1
// entry stays untouched; this module carries what the v2 entry needs.
//
// WHAT v2 DOES NOT GIVE A PLUGIN (checked against @opencode/plugin 2.0.14)
// ------------------------------------------------------------------------
// See V2_DEGRADATIONS. Each is stated, not papered over: a feature that
// quietly stops working looks exactly like one that works and has nothing to
// say, which is the "absent is never zero" failure this repo exists to avoid.

/** Same default as OxideGate itself and the v1 entry. */
const DEFAULT_PORT = 8080;

/**
 * v1 -> v2 gaps, in words. Logged once at v2 startup so the degradation is
 * visible in the log instead of inferred from missing behaviour.
 */
export const V2_DEGRADATIONS = Object.freeze([
  'toasts are unavailable to v2 server plugins (no TUI surface in the plugin context): notices are written to the log instead',
  'ctx.mcp has no connect/disconnect: the connect/disconnect tools and disable-by-default set the server `disabled` flag through ctx.mcp.transform and reload, which is a config-level override for this process, not a runtime socket close/open',
  'ctx.tool.list() takes no provider/model: tool_count is the count of tools registered in this process, not the provider/model-scoped tool list v1 reported, so the `provider` and `model` arguments are accepted and ignored',
]);

/**
 * Normalizes a v2 `mcp.list()` result into the `{ name: { status, error? } }`
 * record that `lib/mcp-transitions.mjs`, `lib/mcp-notices.mjs` and the
 * protection planner already consume (the v1 `client.mcp.status` shape).
 *
 * Returns `null` — never `{}` — for anything unreadable. An empty record
 * means "no servers"; null means "we could not read", and collapsing the two
 * is how an outage becomes a reassuring "0 servers".
 *
 * @param {unknown} list  an array of `{ name, status: {status, error?} }`, or `{ data: array }`
 */
export function mcpListToStatus(list) {
  const entries = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : null;
  if (entries === null) return null;

  const record = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return null;
    const raw = entry.status;
    const word = typeof raw === 'string' ? raw : raw?.status;
    if (typeof word !== 'string') return null;
    record[entry.name] = typeof raw === 'object' && typeof raw.error === 'string' ? { status: word, error: raw.error } : { status: word };
  }
  return record;
}

/**
 * Applies `disabled` overrides to a v2 MCP config editor (the argument of
 * `ctx.mcp.transform`). Only servers the editor already knows are touched: an
 * unknown name is reported as `missing`, never created from thin air.
 *
 * @param {{ get(name: string): unknown, update(name: string, fn: (cfg: any) => void): void }} editor
 * @param {Map<string, boolean> | Record<string, boolean>} overrides  name -> disabled
 */
export function applyMcpOverrides(editor, overrides) {
  const pairs = overrides instanceof Map ? [...overrides] : Object.entries(overrides ?? {});
  const applied = [];
  const missing = [];
  for (const [name, disabled] of pairs) {
    if (editor.get(name) === undefined) {
      missing.push(name);
      continue;
    }
    editor.update(name, (config) => {
      config.disabled = disabled;
    });
    applied.push(name);
  }
  return { applied, missing };
}

/**
 * Has the status caught up with the overrides we asked for? `ctx.mcp.reload()`
 * resolves before the servers have finished moving, so a status read taken
 * right after it can still show the OLD state — reporting that as fact is how
 * a startup notice ends up listing a server as active that was just turned off.
 *
 * - disabled=true  settles when the server reads `disabled`
 * - disabled=false settles when it reads anything but `disabled`
 * - a server absent from the reading is ignored (nothing to wait for)
 * - an unreadable status (null) is never settled — except with no overrides
 *
 * @param {Record<string, {status: string}> | null} status
 * @param {Map<string, boolean> | Record<string, boolean>} overrides
 */
export function overridesSettled(status, overrides) {
  const pairs = overrides instanceof Map ? [...overrides] : Object.entries(overrides ?? {});
  if (pairs.length === 0) return true;
  if (!status || typeof status !== 'object') return false;
  return pairs.every(([name, disabled]) => {
    const entry = status[name];
    if (!entry) return true;
    return disabled ? entry.status === 'disabled' : entry.status !== 'disabled';
  });
}

/**
 * v2 DOES emit an MCP event (`mcp.status.changed`), unlike v1 where polling on
 * `session.idle` was the only option. Subscribing replaces the poll.
 */
export function isMcpStatusChangedEvent(event) {
  return Boolean(event) && typeof event === 'object' && event.type === 'mcp.status.changed';
}

/**
 * v2 plugins cannot show toasts, so a composed notice becomes a log line.
 * `null` in, `null` out: the silence decided in `lib/mcp-notices.mjs` holds.
 */
export function noticeToLogLine(notice) {
  if (!notice) return null;
  return {
    level: notice.variant === 'warning' ? 'warn' : 'log',
    text: `[oxidegate-lens] ${notice.title}: ${notice.message}`,
  };
}

const PROVIDER_MODEL = {
  provider: { type: 'string', description: 'Provider ID. Accepted for v1 compatibility; ignored on OpenCode 2.x.' },
  model: { type: 'string', description: 'Model ID. Accepted for v1 compatibility; ignored on OpenCode 2.x.' },
};

/**
 * JSON Schema for each tool's input (v2 accepts plain JSON Schema, so the v2
 * entry needs no zod/`tool()` helper and no runtime dependency).
 *
 * @param {'valve' | 'connect' | 'disconnect'} kind
 */
export function mcpToolInput(kind) {
  if (kind === 'valve') {
    return { type: 'object', properties: { ...PROVIDER_MODEL } };
  }
  if (kind === 'connect' || kind === 'disconnect') {
    return {
      type: 'object',
      properties: { server: { type: 'string', description: 'MCP server name' }, ...PROVIDER_MODEL },
      required: ['server'],
    };
  }
  throw new Error(`unknown MCP tool kind: ${kind}`);
}

export function summarizeMcpStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return 'MCP actual: unknown';

  const rows = Object.entries(status)
    .map(([name, value]) => `${name}=${value?.status ?? 'unknown'}`)
    .sort();

  return `MCP actual (SDK): ${rows.join(', ') || 'none'}`;
}

/** Same envelope and verbatim warning as the v1 entry's `valveResult`. */
export function valveResult(value) {
  return JSON.stringify(
    {
      caveat: 'oxidegate-lens manual OpenCode MCP valve',
      warning:
        'Manual runtime control only. This does not promise same-request lazy MCP behavior or outgoing tool-list mutation.',
      ...value,
    },
    null,
    2,
  );
}

const orDash = (value, fmt) => (value === null || value === undefined ? '-' : fmt(value));

/**
 * The log line for the newest request OxideGate actually measured, or `null`
 * when there is none. Missing fields print `-`, never zero.
 */
export function latestRequestLine(requests) {
  if (!Array.isArray(requests)) return null;
  const entry = [...requests]
    .reverse()
    .find((r) => r && r.context_measured_bytes !== null && r.context_measured_bytes !== undefined);
  if (!entry) return null;

  const model = orDash(entry.model, String);
  const tax = orDash(entry.context_tax_ratio, (v) => `${(v * 100).toFixed(1)}%`);
  const ttft = orDash(entry.ttft_ms, (v) => `${(v / 1000).toFixed(1)}s`);
  const cost = orDash(entry.cost_estimate_usd, (v) => `$${v.toFixed(4)}`);
  return `[oxidegate-lens] ${model}  tax ${tax}  ttft ${ttft}  ${cost}`;
}

export function resolveBaseUrl(env = process.env) {
  if (env.OXIDEGATE_LENS_URL) return env.OXIDEGATE_LENS_URL;
  return `http://127.0.0.1:${env.OXIDEGATE_PORT ?? String(DEFAULT_PORT)}`;
}
