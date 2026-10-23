// oxidegate-lens.tui.ts
//
// OpenCode 2.x TUI entry (package export "./tui"). Server plugins cannot
// toast in v2; the TUI can, so this is the on-screen half of the notices that
// the server entry can only log.
//
// It needs no @opentui/solid-js import: a toast is plain data passed to
// `ctx.ui.toast.show`. Keeping it that way matters — a regular dependency on
// @opentui/* or solid-js in this package collides with the host's copy
// ("OPENTUI_FORCE_WCWIDTH is already registered"). The wording comes from
// lib/mcp-notices.mjs, shared with the v1 and server entries.
//
//   - transitions: re-reads the MCP list on every `mcp.status.changed` and
//     toasts what moved (diffMcpStatus + transitionNotice).
//   - startup notice: picked up from the handoff file the server entry writes
//     (lib/mcp-notice-handoff.mjs), because only the server knows the plan.

import { diffMcpStatus } from '../lib/mcp-transitions.mjs';
import { transitionNotice } from '../lib/mcp-notices.mjs';
import { mcpListToStatus, toastFromNotice } from '../lib/opencode-v2.mjs';
import { resolveHandoffPath, readFreshStartupNotice } from '../lib/mcp-notice-handoff.mjs';

const STARTUP_NOTICE_MAX_AGE_MS = 120_000;

export default {
  id: 'oxidegate-lens.tui',
  setup: async (ctx: any) => {
    const show = (notice: { title: string; message: string; variant: string } | null) => {
      const toast = toastFromNotice(notice);
      if (!toast) return;
      try {
        ctx.ui.toast.show(toast);
      } catch (error) {
        console.warn(`[oxidegate-lens] toast failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const readStatus = async () => {
      await ctx.data.location.mcp.server.sync();
      return mcpListToStatus(ctx.data.location.mcp.server.list());
    };

    // `undefined` = not looked yet (a baseline, not "no servers").
    let last: unknown;
    let seenStartupId: string | undefined;

    const showStartupNotice = () => {
      const found = readFreshStartupNotice({
        path: resolveHandoffPath(),
        now: Date.now(),
        maxAgeMs: STARTUP_NOTICE_MAX_AGE_MS,
        seenId: seenStartupId,
      });
      if (!found) return;
      seenStartupId = found.id;
      show(found.notice);
    };

    const refresh = async () => {
      try {
        const status = await readStatus();
        const diff = diffMcpStatus(last, status);
        last = status ?? last;
        show(transitionNotice(diff));
        showStartupNotice();
      } catch {
        // A failed read is not a state change; stay quiet rather than toast noise.
      }
    };

    try {
      last = (await readStatus()) ?? undefined;
    } catch {
      last = undefined;
    }
    showStartupNotice();

    const off = ctx.data.on('mcp.status.changed', () => {
      void refresh();
    });
    return () => off();
  },
};
