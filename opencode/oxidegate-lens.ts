// oxidegate-lens.ts
//
// *** EXPERIMENTAL / UNVERIFIED ***
// This plugin is written against the OpenCode plugin docs
// (https://opencode.ai/docs/plugins/ and https://opencode.ai/docs/providers/),
// which are live and not versioned. The hook API used here has NOT been
// verified against a running OpenCode instance. Behavior may differ from
// what is documented, or the hook may not fire as described. Treat this
// file as a best-effort starting point, not a proven integration.
//
// WHAT THIS PLUGIN DOES NOT DO
// -----------------------------
// THIS plugin does not route OpenCode's model traffic through OxideGate.
// It only reads OxideGate's stats AFTER the fact; it does not proxy,
// intercept, or measure anything itself.
//
// It used to say something stronger and wrong: that a plugin CANNOT route
// traffic at all, and that without a top-level "provider" block (see
// examples/opencode.json) OpenCode never talks to OxideGate. That claim
// was outdated. A plugin CAN route traffic by patching global `fetch` —
// a fetch-patch plugin does exactly that today and works. The provider
// block is one way to route; it is not the only one.
//
// Routing stays out of this file's scope either way. The correction is
// here because a comment that overstates a limitation is still a comment
// that lies, and this repo does not get to hold its output to a standard
// its own documentation ignores.
//
// HOOK CHOICE
// -----------
// We use "tool.execute.after" because it fires right after agent activity
// that would plausibly have generated OxideGate proxy traffic (a tool call
// completing is a reasonable proxy for "a request just happened"). Two
// alternatives were considered and rejected:
//   - "session.idle": fires when the session goes idle, a different
//     lifecycle boundary not obviously tied to a single completed request.
//   - "message.updated": fires on message mutation, which may fire many
//     times per request (streaming) or not at all for tool-only turns.
// "tool.execute.after" was the closest documented match to "after a
// message/tool completes."

import { unwrapSdkResponse } from '../lib/sdk-response.mjs';
import { readMcpSavingsSnapshot } from '../lib/mcp-snapshot.mjs';
import { observeMcpUsage } from '../lib/mcp-usage.mjs';
import { buildValveRows } from '../lib/mcp-valve.mjs';
import { readProtectedServers, planMcpDisable, readDisableByDefault } from '../lib/mcp-protection.mjs';
import { diffMcpStatus, partitionByConnected } from '../lib/mcp-transitions.mjs';
import { startupNotice, transitionNotice } from '../lib/mcp-notices.mjs';

// OxideGate's own default. Kept deliberately in sync with it — but 8080 is a
// crowded port (Apache, Tomcat, Jenkins all squat it), so if OxideGate is
// running anywhere else you MUST set OXIDEGATE_PORT. See warnIfNotOxidegate:
// hitting a stranger on this port used to fail completely silently.
const DEFAULT_PORT = 8080;
const FETCH_TIMEOUT_MS = 300;

// OXIDEGATE_MCP_DISABLE_BY_DEFAULT and OXIDEGATE_MCP_ALLOWLIST are both still
// honoured and still win when defined, but their names, their precedence and
// the config file that now carries the same two settings all live in
// lib/mcp-protection.mjs, where they are testable.
const DEBUG_ENV = 'OXIDEGATE_LENS_DEBUG';

function resolveBaseUrl(): string {
  if (process.env.OXIDEGATE_LENS_URL) return process.env.OXIDEGATE_LENS_URL;
  const port = process.env.OXIDEGATE_PORT ?? String(DEFAULT_PORT);
  return `http://127.0.0.1:${port}`;
}

/**
 * Timeout for the one-off startup check only. Deliberately far longer than
 * FETCH_TIMEOUT_MS: this runs once, off the hot path, and a squatter can be
 * slow to answer (a WordPress install page on :8080 took >300ms, which the
 * hook's tight timeout reports as a timeout — indistinguishable from "proxy
 * down". That is exactly why identity is checked HERE and not in the hook.)
 */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Checks ONCE, at plugin load, that whatever sits on the configured port is
 * actually OxideGate — and says so loudly if it isn't.
 *
 * The failure this exists to kill: port 8080 is OxideGate's default AND the
 * favourite of Apache/Tomcat/Jenkins. Point the plugin at a squatter and every
 * read silently returns nothing, which looks exactly like "no traffic yet".
 * Undiagnosable from the outside. A connection refused, by contrast, is a
 * perfectly normal state (OxideGate simply isn't running) and stays quiet.
 */
function probeEndpoint(baseUrl: string): void {
  void (async () => {
    try {
      const res = await fetch(`${baseUrl}/requests`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (Array.isArray(body)) return;

      console.warn(
        `[oxidegate-lens] ${baseUrl} answered, but not with OxideGate data — ` +
          `something else is listening on that port. Set OXIDEGATE_PORT (or ` +
          `OXIDEGATE_LENS_URL) to the port OxideGate actually runs on.`,
      );
    } catch {
      // Unreachable: OxideGate isn't running. Expected, non-fatal, not our
      // business to nag about on every OpenCode start.
    }
  })();
}

function formatValue(value: unknown, fmt: (v: any) => string): string {
  return value === null || value === undefined ? '-' : fmt(value);
}

function countTools(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function debugLog(message: string): void {
  if (!envFlagEnabled(DEBUG_ENV)) return;
  console.log(message);
}

function mcpServerNames(status: unknown): string[] {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
  return Object.keys(status);
}

function summarizeMcpStatus(status: unknown): string {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return 'MCP actual: unknown';

  const rows = Object.entries(status as Record<string, any>)
    .map(([name, value]) => `${name}=${value?.status ?? 'unknown'}`)
    .sort();

  return `MCP actual (SDK): ${rows.join(', ') || 'none'}`;
}

async function showMcpStatusToast(client: any, directory: string | undefined, status: unknown): Promise<void> {
  const showToast = client?.tui?.showToast;
  if (typeof showToast !== 'function') return;

  try {
    await showToast({
      body: {
        title: 'OxideGate MCP actual',
        message: summarizeMcpStatus(status).replace(/^MCP actual \(SDK\): /, ''),
        variant: 'info',
        duration: 5000,
      },
      query: directory ? { directory } : undefined,
    });
  } catch {
    // Toast support is best-effort: older OpenCode builds or non-TUI clients
    // may not expose it. The SDK status marker in tool output remains the
    // durable source of truth.
  }
}

/**
 * Shows a notice composed by `lib/mcp-notices.mjs`. A `null` notice is the
 * common case and means "nothing happened worth interrupting for" — the
 * silence is decided there, not here, so this adapter stays dumb.
 */
async function showNotice(
  client: any,
  directory: string | undefined,
  notice: { title: string; message: string; variant: string } | null,
): Promise<void> {
  if (!notice) return;
  const showToast = client?.tui?.showToast;
  if (typeof showToast !== 'function') {
    // No TUI to speak into. A refusal is a safety event, so it still reaches
    // stderr rather than evaporating with the toast surface.
    if (notice.variant === 'warning') console.warn(`[oxidegate-lens] ${notice.message}`);
    return;
  }

  try {
    await showToast({
      body: {
        title: notice.title,
        message: notice.message,
        variant: notice.variant,
        duration: notice.variant === 'warning' ? 10000 : 5000,
      },
      query: directory ? { directory } : undefined,
    });
  } catch {
    // Best-effort, same as showMcpStatusToast: older builds may not expose it.
  }
}

/**
 * Last MCP status this process observed, for `pollMcpTransitions`.
 * `undefined` means "we have not looked yet", which is NOT the same as "no
 * servers" — `diffMcpStatus` treats it as a baseline and reports nothing.
 */
let lastKnownMcpStatus: unknown;

/**
 * The disable-by-default pass, and the notice that tells the user it happened.
 *
 * Thin by design (design.md Decision 1): every judgement here — which servers
 * are protected, whether it is safe to act, what to say — comes from
 * `lib/*.mjs`, which the suite can actually execute. This function reads the
 * SDK, calls those, and shows a toast.
 */
/**
 * Prices, for the startup notice, so entering the program already shows what
 * the configured MCP servers cost — no command to run, no report to open.
 * Returns undefined when there is no usable snapshot; the notice then falls
 * back to naming servers without figures, which is the honest degradation.
 */
function readPricesForNotice(): { byName: Record<string, any>; freshness: string } | undefined {
  const snapshot = readMcpSavingsSnapshot({});
  if (snapshot.status !== 'known') return undefined;
  const byName: Record<string, any> = {};
  for (const server of snapshot.servers) byName[server.name] = server.price;
  return { byName, freshness: snapshot.freshness };
}

async function disableMcpServersByDefault(client: any, directory: string | undefined): Promise<void> {
  // The switch now lives in the same config file as the list it governs, with
  // the env var still winning when defined. It used to be env-only, and that
  // failed a real test: this feature's own author launched OpenCode without
  // exporting it, so the whole thing silently never ran.
  const _switch = readDisableByDefault({});
  if (_switch.status !== 'known' || !_switch.enabled) {
    if (_switch.status !== 'known') {
      console.warn(
        `[oxidegate-lens] MCP disable-by-default not applied: the config switch is unreadable (${_switch.reason}); doing nothing`,
      );
    }
    return;
  }

  const query = directory ? { directory } : undefined;
  try {
    const status = unwrapSdkResponse(await client.mcp.status({ query }));
    lastKnownMcpStatus = status;
    const servers = mcpServerNames(status);
    const protection = readProtectedServers({});
    const plan = planMcpDisable({ servers, protection });

    // A refusal means we could not read what the user protected. Disconnect
    // nothing and say so loudly — silence would leave them believing their
    // configuration applied. See lib/mcp-protection.mjs.
    if (plan.action === 'refuse') {
      console.warn(
        `[oxidegate-lens] MCP disabled-by-default refused: protection unreadable (${plan.protectionReason}); nothing disconnected`,
      );
      await showNotice(
        client,
        directory,
        startupNotice({ partition: partitionByConnected(status), plan, prices: readPricesForNotice() }),
      );
      return;
    }

    let disabled: string[] = [];
    let failed: string[] = [];
    if (plan.action === 'disable') {
      const results = await Promise.allSettled(
        plan.targets.map(async (server: string) => {
          await client.mcp.disconnect({ path: { name: server }, query });
          return server;
        }),
      );
      disabled = results
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => r.value);
      failed = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => formatError(r.reason));
    }

    debugLog(
      `[oxidegate-lens] MCP disabled-by-default enabled; action=${plan.action} disabled=${
        disabled.join(', ') || '-'
      } preserved=${plan.preserved.join(', ') || '-'} protectionSource=${protection.source}${
        failed.length ? ` failed=${failed.join(' | ')}` : ''
      }`,
    );

    // Re-read rather than assume: a disconnect that failed must not be
    // reported as a server that is off.
    const afterStatus = unwrapSdkResponse(await client.mcp.status({ query }));
    lastKnownMcpStatus = afterStatus;
    await showNotice(
      client,
      directory,
      startupNotice({ partition: partitionByConnected(afterStatus), plan, prices: readPricesForNotice() }),
    );
  } catch (error) {
    console.warn(`[oxidegate-lens] MCP disabled-by-default failed: ${formatError(error)}`);
  }
}

/**
 * Reads the MCP status and reports what moved since the last reading.
 *
 * OpenCode emits NO MCP event — the SDK's `Event` union has 32 members and
 * none is MCP-shaped — so there is nothing to subscribe to and polling is the
 * only way to notice a connection we did not cause ourselves. This runs off
 * events that DO fire (`session.idle`), so it costs one status call per idle
 * rather than a timer that keeps ticking in an abandoned session.
 *
 * The consequence is honest and worth stating: a notice arrives at the next
 * idle, never at the instant of the connection.
 */
async function pollMcpTransitions(client: any, directory: string | undefined): Promise<void> {
  const query = directory ? { directory } : undefined;
  try {
    const status = unwrapSdkResponse(await client.mcp.status({ query }));
    const diff = diffMcpStatus(lastKnownMcpStatus, status);
    // Store even when the diff was unreadable-or-baseline, so the NEXT poll
    // has something to compare against.
    lastKnownMcpStatus = status;
    await showNotice(client, directory, transitionNotice(diff));
  } catch (error) {
    // A failed poll is not a state change. Stay quiet at debug level rather
    // than warn on every idle of a session with no MCP support at all.
    debugLog(`[oxidegate-lens] MCP transition poll failed: ${formatError(error)}`);
  }
}

async function loadOpenCodeToolHelper(): Promise<any | null> {
  try {
    return (await import('@opencode-ai/plugin')).tool;
  } catch (error) {
    console.warn(
      `[oxidegate-lens] manual MCP valve tools unavailable: @opencode-ai/plugin could not be loaded (${formatError(
        error,
      )}). Existing OxideGate observer logging remains active.`,
    );
    return null;
  }
}

async function collectMcpValveSnapshot(
  client: any,
  directory: string | undefined,
  provider?: string,
  model?: string,
): Promise<Record<string, unknown>> {
  const query = directory ? { directory } : undefined;
  const status = unwrapSdkResponse(await client.mcp.status({ query }));
  const snapshot: Record<string, unknown> = {
    mcp_status: status,
    mcp_state_marker: summarizeMcpStatus(status),
    mcp_server_count: status && typeof status === 'object' ? Object.keys(status).length : null,
  };

  if (provider && model) {
    const tools = unwrapSdkResponse(
      await client.tool.list({
        query: {
          ...(directory ? { directory } : {}),
          provider,
          model,
        },
      }),
    );

    snapshot.tool_list = tools;
    snapshot.tool_count = countTools(tools);
  } else {
    snapshot.tool_list = 'skipped: pass provider and model to compare OpenCode tool-list size';
    snapshot.tool_count = null;
  }

  return snapshot;
}

/**
 * Joins the mcp-savings price snapshot against OxideGate's observed wire
 * usage via `lib/mcp-valve.mjs`'s `buildValveRows` — the exact same three
 * calls, same order, as `bin/oxidegate-savings.mjs`'s section (d). Needs the
 * FULL `/requests` array (not a single entry) to derive the observation
 * window, so it fetches it itself, reusing `logLatestRequest`'s fetch
 * pattern below. Never throws: a fetch failure degrades to an empty
 * `requests` array, which `observeMcpUsage` already treats as
 * `insufficient-observation` — this function does no additional guessing.
 */
async function collectInformedValve(): Promise<ReturnType<typeof buildValveRows>> {
  const baseUrl = resolveBaseUrl();
  let requests: unknown = [];
  try {
    const res = await fetch(`${baseUrl}/requests`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    requests = res.ok ? await res.json().catch(() => []) : [];
  } catch {
    requests = [];
  }

  const snapshot = readMcpSavingsSnapshot();
  const usage = observeMcpUsage(Array.isArray(requests) ? requests : []);
  return buildValveRows({ snapshot, usage });
}

function valveResult(value: Record<string, unknown>): string {
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

async function logLatestRequest(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const res = await fetch(`${baseUrl}/requests`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return;

  const requests = await res.json();
  if (!Array.isArray(requests) || requests.length === 0) return;

  const entry = [...requests]
    .reverse()
    .find((r) => r && r.context_measured_bytes !== null && r.context_measured_bytes !== undefined);
  if (!entry) return;

  const model = formatValue(entry.model, (v) => String(v));
  const tax = formatValue(entry.context_tax_ratio, (v) => `${(v * 100).toFixed(1)}%`);
  const ttft = formatValue(entry.ttft_ms, (v) => `${(v / 1000).toFixed(1)}s`);
  const cost = formatValue(entry.cost_estimate_usd, (v) => `$${v.toFixed(4)}`);

  // Plain console.log is the safest, most portable choice here since the
  // exact logging surface OpenCode expects from a plugin hook is unverified.
  console.log(`[oxidegate-lens] ${model}  tax ${tax}  ttft ${ttft}  ${cost}`);
}

// Named export required by the OpenCode plugin contract — a default export
// will NOT be picked up.
export async function OxidegateLens({ project, client, $, directory, worktree }: any) {
  // Once, at load: is the thing on that port even OxideGate? Wrong-port is the
  // single most likely misconfiguration, and it is invisible from the hook.
  probeEndpoint(resolveBaseUrl());
  const openCodeTool = await loadOpenCodeToolHelper();
  void disableMcpServersByDefault(client, directory);

  return {
    // There is no MCP event to subscribe to, so we ride one that exists.
    // `session.idle` fires when the agent stops working — the moment a poll
    // is cheapest and a toast is least intrusive. Any connection made since
    // the last idle surfaces here; nothing surfaces at the instant it
    // happens, and lib/mcp-transitions.mjs's baseline rule keeps the first
    // reading from firing a burst of false notices.
    event: async ({ event }: any) => {
      if (event?.type !== 'session.idle') return;
      await pollMcpTransitions(client, directory);
    },
    ...(openCodeTool
      ? {
          tool: {
            oxidegate_lens_mcp_valve: openCodeTool({
              description:
                'Inspect OpenCode MCP server status, join it with mcp-savings price data and OxideGate observed wire usage, and report a per-server recommendation (candidate-to-disable / already-off / no-recommendation, each with a named reason) before manual MCP valve tests.',
              args: {
                provider: openCodeTool.schema.string().optional(),
                model: openCodeTool.schema.string().optional(),
              },
              async execute(args, context) {
                try {
                  const snapshot = await collectMcpValveSnapshot(
                    client,
                    context.directory ?? directory,
                    args.provider,
                    args.model,
                  );
                  const valve = await collectInformedValve();
                  const toolCount = snapshot.tool_count === null ? 'skipped' : snapshot.tool_count;
                  console.log(
                    `[oxidegate-lens] MCP valve snapshot; tools=${toolCount}; ${snapshot.mcp_state_marker}`,
                  );
                  await showMcpStatusToast(client, context.directory ?? directory, snapshot.mcp_status);
                  return valveResult({
                    ok: true,
                    action: 'valve',
                    snapshot,
                    rows: valve.rows,
                    joinHealth: valve.joinHealth,
                    windowMs: valve.windowMs,
                    snapshotFreshness: valve.snapshotFreshness,
                    snapshotTimestamp: valve.snapshotTimestamp,
                  });
                } catch (error) {
                  return valveResult({ ok: false, action: 'valve', error: formatError(error) });
                }
              },
            }),
            oxidegate_lens_mcp_disconnect: openCodeTool({
              description: 'Manually disconnect one OpenCode MCP server and report MCP/tool-list snapshots before and after.',
              args: {
                server: openCodeTool.schema.string(),
                provider: openCodeTool.schema.string().optional(),
                model: openCodeTool.schema.string().optional(),
              },
              async execute(args, context) {
                const activeDirectory = context.directory ?? directory;
                try {
                  const before = await collectMcpValveSnapshot(client, activeDirectory, args.provider, args.model);
                  const disconnected = unwrapSdkResponse(
                    await client.mcp.disconnect({
                      path: { name: args.server },
                      query: activeDirectory ? { directory: activeDirectory } : undefined,
                    }),
                  );
                  const after = await collectMcpValveSnapshot(client, activeDirectory, args.provider, args.model);
                  console.log(`[oxidegate-lens] MCP disconnect ${args.server}; result=${disconnected}`);
                  return valveResult({
                    ok: true,
                    action: 'disconnect',
                    server: args.server,
                    sdk_result: disconnected,
                    before,
                    after,
                  });
                } catch (error) {
                  return valveResult({
                    ok: false,
                    action: 'disconnect',
                    server: args.server,
                    error: formatError(error),
                  });
                }
              },
            }),
            oxidegate_lens_mcp_connect: openCodeTool({
              description: 'Manually connect one OpenCode MCP server and report MCP/tool-list snapshots before and after.',
              args: {
                server: openCodeTool.schema.string(),
                provider: openCodeTool.schema.string().optional(),
                model: openCodeTool.schema.string().optional(),
              },
              async execute(args, context) {
                const activeDirectory = context.directory ?? directory;
                try {
                  const before = await collectMcpValveSnapshot(client, activeDirectory, args.provider, args.model);
                  const connected = unwrapSdkResponse(
                    await client.mcp.connect({
                      path: { name: args.server },
                      query: activeDirectory ? { directory: activeDirectory } : undefined,
                    }),
                  );
                  const after = await collectMcpValveSnapshot(client, activeDirectory, args.provider, args.model);
                  console.log(`[oxidegate-lens] MCP connect ${args.server}; result=${connected}`);
                  return valveResult({
                    ok: true,
                    action: 'connect',
                    server: args.server,
                    sdk_result: connected,
                    before,
                    after,
                  });
                } catch (error) {
                  return valveResult({
                    ok: false,
                    action: 'connect',
                    server: args.server,
                    error: formatError(error),
                  });
                }
              },
            }),
          },
        }
      : {}),
    'tool.execute.after': async () => {
      try {
        await logLatestRequest();
      } catch {
        // Silent by design: this runs after EVERY tool call, so it must be
        // fast and quiet. Misconfiguration is reported once by probeEndpoint
        // above, not from in here.
      }
    },
  };
}
