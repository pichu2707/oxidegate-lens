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

  return {
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
