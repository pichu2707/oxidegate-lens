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

const DEFAULT_PORT = 8080;
const FETCH_TIMEOUT_MS = 300;

function resolveBaseUrl(): string {
  if (process.env.OXIDEGATE_LENS_URL) return process.env.OXIDEGATE_LENS_URL;
  const port = process.env.OXIDEGATE_PORT ?? String(DEFAULT_PORT);
  return `http://127.0.0.1:${port}`;
}

function formatValue(value: unknown, fmt: (v: any) => string): string {
  return value === null || value === undefined ? '-' : fmt(value);
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
  return {
    'tool.execute.after': async () => {
      try {
        await logLatestRequest();
      } catch {
        // Silent by design: a plugin hook must never throw uncaught, and a
        // missing/unreachable OxideGate proxy is an expected, non-fatal state.
      }
    },
  };
}
