// lib/sdk-response.mjs
//
// CONTRACT
// --------
// The OpenCode SDK is openapi-fetch style: called without `throwOnError`,
// every method resolves to a result tuple `{ data, error, request, response }`
// instead of throwing. On success, `data` holds the parsed body and `error`
// is `undefined`/`null`. On a non-2xx response, it is the other way around:
// `data` is `undefined` and the parsed error body lives under `error`.
//
// THE DEFECT THIS MODULE FIXES
// -----------------------------
// The original inline `unwrapSdkResponse` in `opencode/oxidegate-lens.ts`
// checked `'data' in value` to decide whether a tuple looked like a
// success. That check is true on BOTH branches above — the `data` key
// exists on an error tuple too, it's just `undefined`. So a real SDK
// failure (bad request, server down mid-call, malformed args, ...) was
// silently unwrapped to `value.data`, i.e. `undefined`, and `value.error`
// was never even read. Every one of the 7 call sites in
// `opencode/oxidegate-lens.ts` sits inside a try/catch that logs a warning
// or degrades gracefully on failure — but none of that ever ran, because
// nothing ever threw. A dead MCP status call looked exactly like "0 tools",
// not "couldn't ask." That is the same "unknown collapsed into zero"
// failure class `lib/mcp-config.mjs`'s FAILURE POLICY exists to prevent one
// layer up — see that module's header comment for the sibling defect.
//
// THE FIX
// -------
// Check `error` first, not `data`. A non-null `error` means the tuple is
// the failure branch: throw, so the call site's own try/catch can log or
// degrade the way it already intends to. Only when there is no error do we
// treat `data` (however "empty" it happens to be) as a legitimate result.
//
// Exports:
//   unwrapSdkResponse(value) -> unknown (or throws)

/**
 * Unwraps an openapi-fetch style SDK result tuple.
 *
 * - Not an object (including `null`) -> returned unchanged; not a tuple.
 * - `value.error` is non-null -> THROWS. If `error` is already an `Error`
 *   instance, that exact instance is thrown (no re-wrapping, so identity
 *   and stack trace are preserved). Otherwise a new `Error` is thrown whose
 *   `.cause` is the original `error` body and whose `.message` is: the
 *   string itself when `error` is a string, else `error.message` when that
 *   is a string, else the JSON-stringified error body.
 * - `'data' in value` (and no error) -> returns `value.data`, even when
 *   that is `undefined` — a legitimate empty success must not throw.
 * - Otherwise -> returned unchanged; not a recognizable result tuple.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function unwrapSdkResponse(value) {
  if (value === null || typeof value !== 'object') return value;

  if ('error' in value && value.error != null) {
    const { error } = value;
    if (error instanceof Error) throw error;

    const message =
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : JSON.stringify(error);

    throw new Error(message, { cause: error });
  }

  if ('data' in value) return value.data;

  return value;
}
