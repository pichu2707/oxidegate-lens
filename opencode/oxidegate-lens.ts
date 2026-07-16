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
// This plugin CANNOT route OpenCode's actual model traffic through
// OxideGate. A plugin has no ability to set a provider `baseURL` — that is
// a separate, top-level "provider" key in opencode.json (see
// examples/opencode.json in this repo). Without that provider block,
// OpenCode never talks to OxideGate at all, and this plugin will simply
// read stale or empty data from GET /requests forever.
//
// This plugin only reads OxideGate's stats AFTER the fact. It does not
// proxy, intercept, or measure anything itself.
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

// OxideGate's own default. Kept deliberately in sync with it — but 8080 is a
// crowded port (Apache, Tomcat, Jenkins all squat it), so if OxideGate is
// running anywhere else you MUST set OXIDEGATE_PORT. See warnIfNotOxidegate:
// hitting a stranger on this port used to fail completely silently.
const DEFAULT_PORT = 8080;
const FETCH_TIMEOUT_MS = 300;

const MCP_DISABLE_BY_DEFAULT_ENV = 'OXIDEGATE_MCP_DISABLE_BY_DEFAULT';
const MCP_ALLOWLIST_ENV = 'OXIDEGATE_MCP_ALLOWLIST';

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

function unwrapSdkResponse(value: any): any {
  if (value && typeof value === 'object' && 'data' in value) return value.data;
  return value;
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

function mcpServerNames(status: unknown): string[] {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
  return Object.keys(status);
}

function envList(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function disableMcpServersByDefault(client: any, directory: string | undefined): Promise<void> {
  if (!envFlagEnabled(MCP_DISABLE_BY_DEFAULT_ENV)) return;

  const allowlist = envList(MCP_ALLOWLIST_ENV);
  const query = directory ? { directory } : undefined;
  try {
    const status = unwrapSdkResponse(await client.mcp.status({ query }));
    const servers = mcpServerNames(status);
    const serversToDisable = servers.filter((server) => !allowlist.has(server));
    const preserved = servers.filter((server) => allowlist.has(server));
    if (servers.length === 0) {
      console.log('[oxidegate-lens] MCP disabled-by-default enabled; no MCP servers found');
      return;
    }

    if (serversToDisable.length === 0) {
      console.log(
        `[oxidegate-lens] MCP disabled-by-default enabled; disabled=- preserved=${preserved.join(', ') || '-'}`,
      );
      return;
    }

    const results = await Promise.allSettled(
      serversToDisable.map(async (server) => {
        await client.mcp.disconnect({
          path: { name: server },
          query,
        });
        return server;
      }),
    );

    const disabled = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => formatError(r.reason));

    console.log(
      `[oxidegate-lens] MCP disabled-by-default enabled; disabled=${disabled.join(', ') || '-'} preserved=${
        preserved.join(', ') || '-'
      }${
        failed.length ? ` failed=${failed.join(' | ')}` : ''
      }`,
    );
  } catch (error) {
    console.warn(`[oxidegate-lens] MCP disabled-by-default failed: ${formatError(error)}`);
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

function valveResult(value: Record<string, unknown>): string {
  return JSON.stringify(
    {
      experiment: 'oxidegate-lens manual OpenCode MCP valve',
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
    ...(openCodeTool
      ? {
          tool: {
            oxidegate_lens_experimental_mcp_status: openCodeTool({
              description:
                'EXPERIMENTAL: inspect OpenCode MCP server status and optionally list tools for a provider/model before manual MCP valve tests.',
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
                  const toolCount = snapshot.tool_count === null ? 'skipped' : snapshot.tool_count;
                  console.log(`[oxidegate-lens] experimental MCP status snapshot; tools=${toolCount}`);
                  return valveResult({ ok: true, action: 'status', snapshot });
                } catch (error) {
                  return valveResult({ ok: false, action: 'status', error: formatError(error) });
                }
              },
            }),
            oxidegate_lens_experimental_mcp_disconnect: openCodeTool({
              description:
                'EXPERIMENTAL: manually disconnect one OpenCode MCP server and report MCP/tool-list snapshots before and after.',
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
                  console.log(`[oxidegate-lens] experimental MCP disconnect ${args.server}; result=${disconnected}`);
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
            oxidegate_lens_experimental_mcp_connect: openCodeTool({
              description:
                'EXPERIMENTAL: manually connect one OpenCode MCP server and report MCP/tool-list snapshots before and after.',
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
                  console.log(`[oxidegate-lens] experimental MCP connect ${args.server}; result=${connected}`);
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
