// oxidegate-lens.server.ts
//
// OpenCode 2.x entry (package export "./server"). The v1 entry,
// opencode/oxidegate-lens.ts, is untouched and still serves OpenCode 1.x.
//
// OpenCode 2.x changed the plugin contract: a plugin default-exports a
// definition `{ id, setup(ctx) }` instead of a named async function that
// receives an SDK `client`. This file is the thin adapter for that contract;
// every decision it makes (status shape, overrides, notice wording, tool
// schemas) lives in lib/*.mjs, where the suite can execute it.
//
// It is a plain object on purpose: `Plugin.define()` from @opencode/plugin is
// an identity function, so importing it would add a runtime dependency (and a
// load failure mode) for no behaviour.
//
// WHAT v2 CANNOT DO AS v1 DID — see V2_DEGRADATIONS in lib/opencode-v2.mjs,
// which is also logged once at startup so the gap is visible, not inferred:
//   - no toasts           -> notices are logged
//   - no mcp connect/disconnect on the plugin context
//                         -> `disabled` override via ctx.mcp.transform + reload
//   - no provider/model-scoped tool list -> count of registered tools
// WHY THIS DEFAULT EXPORT ALSO CARRIES `server`
// OpenCode 1.x resolves a package's "./server" export too (observed on
// 1.19.4) and, for a default export, demands `{ server() }`. Pointing
// "./server" at a v2-only object therefore breaks v1 at load time. So the
// definition is both shapes at once: `id` + `setup` for v2, and `server`
// (the untouched v1 plugin function) for v1. Each runtime ignores the key it
// does not know.
//
// What v2 does BETTER: it emits `mcp.status.changed`, so transitions are
// event-driven instead of polled on session.idle.

import { OxidegateLens } from './oxidegate-lens.ts';
import { readMcpSavingsSnapshot } from '../lib/mcp-snapshot.mjs';
import { observeMcpUsage } from '../lib/mcp-usage.mjs';
import { buildValveRows } from '../lib/mcp-valve.mjs';
import { readProtectedServers, planMcpDisable, readDisableByDefault } from '../lib/mcp-protection.mjs';
import { diffMcpStatus, partitionByConnected } from '../lib/mcp-transitions.mjs';
import { startupNotice, transitionNotice } from '../lib/mcp-notices.mjs';
import { readProjectConfig, readApprovals } from '../lib/mcp-project-config.mjs';
import {
  mcpListToStatus,
  applyMcpOverrides,
  isMcpStatusChangedEvent,
  overridesSettled,
  waitUntilSettled,
  planSwitch,
  noticeToLogLine,
  mcpToolInput,
  V2_DEGRADATIONS,
  summarizeMcpStatus,
  valveResult,
  latestRequestLine,
  resolveBaseUrl,
} from '../lib/opencode-v2.mjs';

const FETCH_TIMEOUT_MS = 300;
const PROBE_TIMEOUT_MS = 2000;
const DEBUG_ENV = 'OXIDEGATE_LENS_DEBUG';

// v2 hides plugin tools behind its `execute` code-mode tool unless told
// otherwise. v1 exposed these three as plain tools (and consumers enable them
// by name), so keep them directly callable.
// Safety net only. Measured on 2.1.4: `ctx.mcp.reload()` resolves only after
// the changed server has finished (re)connecting, and the status already
// shows the override when it returns (settle wait ~0 ms). The wait below is
// woken by `mcp.status.changed`; this timeout just bounds a lost event.
const SETTLE_TIMEOUT_MS = 3000;

const DIRECT_TOOL = { codemode: false };

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// OpenCode 2.x runs the server over `serve --stdio`, where stdout carries the
// RPC channel: anything written with console.log is lost (or worse, corrupts
// framing). Every informational line therefore goes to stderr.
function stderrLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function debugLog(message: string): void {
  const value = process.env[DEBUG_ENV]?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') stderrLog(message);
}

function emitNotice(notice: { title: string; message: string; variant: string } | null): void {
  const line = noticeToLogLine(notice);
  if (!line) return;
  if (line.level === 'warn') console.warn(line.text);
  else stderrLog(line.text);
}

/** Same one-off identity check as the v1 entry: is whatever sits on the port OxideGate? */
function probeEndpoint(baseUrl: string): void {
  void (async () => {
    try {
      const res = await fetch(`${baseUrl}/requests`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (Array.isArray(body)) return;
      console.warn(
        `[oxidegate-lens] ${baseUrl} answered, but not with OxideGate data — ` +
          `something else is listening on that port. Set OXIDEGATE_PORT (or ` +
          `OXIDEGATE_LENS_URL) to the port OxideGate actually runs on.`,
      );
    } catch {
      // Unreachable: OxideGate isn't running. Expected, non-fatal, not worth nagging about.
    }
  })();
}

async function fetchRequests(): Promise<unknown[]> {
  try {
    const res = await fetch(`${resolveBaseUrl()}/requests`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = res.ok ? await res.json().catch(() => []) : [];
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

function readPricesForNotice(): { byName: Record<string, any>; freshness: string } | undefined {
  const snapshot = readMcpSavingsSnapshot({});
  if (snapshot.status !== 'known') return undefined;
  const byName: Record<string, any> = {};
  for (const server of snapshot.servers) byName[server.name] = server.price;
  return { byName, freshness: snapshot.freshness };
}

export default {
  id: 'oxidegate-lens',
  // v1 (OpenCode 1.x) entry point, reused as-is.
  server: OxidegateLens,
  // v2 (OpenCode 2.x) entry point.
  setup: async (ctx: any) => {
    const directory: string | undefined = ctx.location?.directory;
    // name -> disabled. The transform below re-applies these on every reload.
    const overrides = new Map<string, boolean>();
    // `undefined` = "not looked yet", which is NOT "no servers" (see lib/mcp-transitions.mjs).
    let lastKnownMcpStatus: unknown;
    const controller = new AbortController();
    // Callbacks woken by every mcp.status.changed (see waitUntilSettled).
    const statusListeners = new Set<() => void>();

    probeEndpoint(resolveBaseUrl());
    console.warn(`[oxidegate-lens] running on OpenCode 2.x with reduced capabilities: ${V2_DEGRADATIONS.join('; ')}`);

    const readStatus = async () => mcpListToStatus(await ctx.mcp.list());

    // Reloads, then waits (bounded) for the status to reflect `overrides`.
    // Returns whether it did; the caller reports the reading either way, so a
    // timeout degrades to "read at timeout", never to a silent assumption.
    // `expect` is the subset of overrides this call is responsible for: other
    // entries in `overrides` may legitimately disagree with the status (the
    // user can flip a server from the TUI), and must not fail this wait.
    const reloadAndSettle = async (
      expect: Map<string, boolean> = overrides,
    ): Promise<{ settled: boolean; reloadMs: number; settleMs: number }> => {
      const t0 = Date.now();
      await ctx.mcp.reload();
      const t1 = Date.now();
      // Event-driven (no polling): subscribed before the first check, so a
      // change landing in between is not missed. See waitUntilSettled.
      const settled = await waitUntilSettled({
        check: async () => overridesSettled(await readStatus(), expect),
        subscribe: (cb) => {
          statusListeners.add(cb);
          return () => statusListeners.delete(cb);
        },
        timeoutMs: SETTLE_TIMEOUT_MS,
      });
      return { settled, reloadMs: t1 - t0, settleMs: Date.now() - t1 };
    };

    // The config value each server had BEFORE our override, as seen by the
    // last transform run (needed by planSwitch).
    const baseDisabled = new Map<string, boolean | undefined>();

    // Moves one server. When the config already holds the wanted value but the
    // server is elsewhere (TUI /mcp changes runtime state, not config),
    // reconcile would skip it, so flip to the opposite value first. See planSwitch.
    const applyOverride = async (server: string, action: 'connect' | 'disconnect') => {
      const status = (await readStatus())?.[server]?.status;
      const plan = planSwitch({ action, status, applied: overrides.get(server), base: baseDisabled.get(server) });
      let reloadMs = 0;
      let settleMs = 0;
      if (plan.mode === 'toggle') {
        overrides.set(server, !plan.disabled);
        const first = await reloadAndSettle(new Map([[server, !plan.disabled]]));
        reloadMs += first.reloadMs;
        settleMs += first.settleMs;
        if (!first.settled) return { settled: false, reloadMs, settleMs, toggled: true };
      }
      overrides.set(server, plan.disabled);
      const last = await reloadAndSettle(new Map([[server, plan.disabled]]));
      return { settled: last.settled, reloadMs: reloadMs + last.reloadMs, settleMs: settleMs + last.settleMs, toggled: plan.mode === 'toggle' };
    };

    await ctx.mcp.transform((editor: any) => {
      const { missing, previous } = applyMcpOverrides(editor, overrides);
      for (const name of missing) overrides.delete(name);
      for (const [name, value] of Object.entries(previous)) baseDisabled.set(name, value as boolean | undefined);
    });

    const collectSnapshot = async () => {
      const status = await readStatus();
      const tools = await ctx.tool.list();
      return {
        mcp_status: status,
        mcp_state_marker: summarizeMcpStatus(status),
        mcp_server_count: status ? Object.keys(status).length : null,
        tool_list: tools.map((tool: any) => tool.id),
        tool_count: tools.length,
        tool_count_scope: 'all tools registered in this process (v2 has no provider/model-scoped tool list)',
      };
    };

    const collectInformedValve = async () => {
      const snapshot = readMcpSavingsSnapshot();
      const usage = observeMcpUsage(await fetchRequests());
      return buildValveRows({ snapshot, usage });
    };

    const switchServer = (action: 'connect' | 'disconnect') => async (input: any) => {
      const server = input?.server;
      try {
        const before = await collectSnapshot();
        if (!before.mcp_status || !(server in before.mcp_status)) {
          throw new Error(`unknown MCP server: ${server}`);
        }
        const { settled, reloadMs, settleMs, toggled } = await applyOverride(server, action);
        const after = await collectSnapshot();
        stderrLog(`[oxidegate-lens] MCP ${action} ${server}; via ctx.mcp.transform+reload; settled=${settled}`);
        return {
          content: valveResult({
            ok: true,
            action,
            server,
            sdk_result: `disabled=${action === 'disconnect'} (config override + reload; not a socket-level ${action})`,
            settled,
            toggled,
            timing_ms: { reload: reloadMs, settle: settleMs },
            before,
            after,
          }),
        };
      } catch (error) {
        return { content: valveResult({ ok: false, action, server, error: formatError(error) }) };
      }
    };

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: 'oxidegate_lens_mcp_valve',
        description:
          'Inspect OpenCode MCP server status, join it with mcp-savings price data and OxideGate observed wire usage, and report a per-server recommendation (candidate-to-disable / already-off / no-recommendation, each with a named reason) before manual MCP valve tests.',
        input: mcpToolInput('valve'),
        options: DIRECT_TOOL,
        execute: async () => {
          try {
            const snapshot = await collectSnapshot();
            const valve = await collectInformedValve();
            stderrLog(`[oxidegate-lens] MCP valve snapshot; tools=${snapshot.tool_count}; ${snapshot.mcp_state_marker}`);
            return {
              content: valveResult({
                ok: true,
                action: 'valve',
                snapshot,
                rows: valve.rows,
                joinHealth: valve.joinHealth,
                windowMs: valve.windowMs,
                snapshotFreshness: valve.snapshotFreshness,
                snapshotTimestamp: valve.snapshotTimestamp,
              }),
            };
          } catch (error) {
            return { content: valveResult({ ok: false, action: 'valve', error: formatError(error) }) };
          }
        },
      });
      editor.add({
        name: 'oxidegate_lens_mcp_disconnect',
        description: 'Manually disconnect one OpenCode MCP server and report MCP/tool-list snapshots before and after.',
        input: mcpToolInput('disconnect'),
        options: DIRECT_TOOL,
        execute: switchServer('disconnect'),
      });
      editor.add({
        name: 'oxidegate_lens_mcp_connect',
        description: 'Manually connect one OpenCode MCP server and report MCP/tool-list snapshots before and after.',
        input: mcpToolInput('connect'),
        options: DIRECT_TOOL,
        execute: switchServer('connect'),
      });
    });

    // After every tool call, log the newest measured request. Silent on any
    // failure: this runs constantly and misconfiguration is reported once by
    // probeEndpoint.
    await ctx.tool.hook('execute.after', async () => {
      try {
        const line = latestRequestLine(await fetchRequests());
        if (line) stderrLog(line);
      } catch {
        // see above
      }
    });

    const pollMcpTransitions = async () => {
      try {
        const status = await readStatus();
        const diff = diffMcpStatus(lastKnownMcpStatus, status);
        lastKnownMcpStatus = status ?? lastKnownMcpStatus;
        emitNotice(transitionNotice(diff));
      } catch (error) {
        debugLog(`[oxidegate-lens] MCP transition poll failed: ${formatError(error)}`);
      }
    };

    // v2 emits mcp.status.changed: event-driven, no polling.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (isMcpStatusChangedEvent(event)) {
            for (const wake of [...statusListeners]) wake();
            await pollMcpTransitions();
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`[oxidegate-lens] MCP event subscription ended: ${formatError(error)}; transition notices stop`);
        }
      }
    })();

    const disableMcpServersByDefault = async () => {
      const projectConfig = readProjectConfig({ cwd: directory, approvals: readApprovals({}) });
      if (projectConfig.status === 'pending') {
        console.warn(
          `[oxidegate-lens] hay una configuración de proyecto SIN aprobar en ${projectConfig.path} ` +
            `(contenido ${projectConfig.approvalHash}); NO se está aplicando. Revísala y apruébala ` +
            'con `oxidegate-mcp --approve` si te parece bien.',
        );
      }

      const _switch = readDisableByDefault({ projectConfig });
      if (_switch.status !== 'known' || !_switch.enabled) {
        if (_switch.status !== 'known') {
          console.warn(
            `[oxidegate-lens] MCP disable-by-default not applied: the config switch is unreadable (${_switch.reason}); doing nothing`,
          );
        }
        return;
      }

      try {
        // At plugin load the initial reconcile may not have registered the
        // configured servers yet, so an EMPTY list can mean "not loaded yet"
        // rather than "none configured". Give it one event-driven chance to
        // fill in (bounded) before concluding there is nothing to do.
        await waitUntilSettled({
          check: async () => Object.keys((await readStatus()) ?? {}).length > 0,
          subscribe: (cb) => {
            statusListeners.add(cb);
            return () => statusListeners.delete(cb);
          },
          timeoutMs: SETTLE_TIMEOUT_MS,
        });
        const status = await readStatus();
        lastKnownMcpStatus = status ?? undefined;
        const servers = status ? Object.keys(status) : [];
        const protection = readProtectedServers({ projectConfig });
        const plan = planMcpDisable({ servers, protection });

        if (plan.action === 'refuse') {
          console.warn(
            `[oxidegate-lens] MCP disabled-by-default refused: protection unreadable (${plan.protectionReason}); nothing disconnected`,
          );
          emitNotice(startupNotice({ partition: partitionByConnected(status), plan, prices: readPricesForNotice() }));
          return;
        }

        if (plan.action === 'disable') {
          for (const server of plan.targets) overrides.set(server, true);
          const outcome = await reloadAndSettle();
          debugLog(`[oxidegate-lens] MCP disabled-by-default reload=${outcome.reloadMs}ms settle=${outcome.settleMs}ms settled=${outcome.settled}`);
          if (!outcome.settled) {
            console.warn(
              `[oxidegate-lens] MCP disabled-by-default: status did not reflect the override within ${SETTLE_TIMEOUT_MS}ms; the notice below shows what was read, not what was asked`,
            );
          }
        }

        debugLog(
          `[oxidegate-lens] MCP disabled-by-default enabled; action=${plan.action} disabled=${
            plan.action === 'disable' ? plan.targets.join(', ') || '-' : '-'
          } preserved=${plan.preserved.join(', ') || '-'} protectionSource=${protection.source}`,
        );

        // Re-read rather than assume: an override that did not take must not be reported as off.
        const afterStatus = await readStatus();
        lastKnownMcpStatus = afterStatus ?? undefined;
        emitNotice(startupNotice({ partition: partitionByConnected(afterStatus), plan, prices: readPricesForNotice() }));
      } catch (error) {
        console.warn(`[oxidegate-lens] MCP disabled-by-default failed: ${formatError(error)}`);
      }
    };
    void disableMcpServersByDefault();

    return () => controller.abort();
  },
};
