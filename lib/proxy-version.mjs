// lib/proxy-version.mjs
//
// CONTRACT
// --------
// Reads OxideGate's `GET /version` — a CAPABILITIES endpoint, not a
// telemetry one. PURE except for one fetch call, which takes an injectable
// `fetchImpl` with a real default (`fetch`), same shape as `verify` in
// `lib/mcp-endpoint.mjs`. NEVER throws.
//
// Exports:
//   readProxyVersion({ baseUrl, fetchImpl?, timeoutMs? }) -> Promise<VersionResult>
//   publishesEndpoint(version, endpoint) -> true | false | null
//   publishesField(version, field) -> true | false | null
//
// VersionResult is one of:
//   { status: 'known', contract, endpoints: string[], fields: string[], oxidegate }
//   { status: 'known', reason: 'pre-contract' }
//   { status: 'unknown', reason: 'unreachable' | 'timeout' | 'unparseable' |
//                                  'unexpected-shape' | 'http-<code>' }
//
// WHY THIS EXISTS
// ----------------
// `/version` is how OxideGate ANNOUNCES what it can do — which endpoints and
// fields exist in this build. Without reading it, the lens has to "probe by
// absence": it cannot tell "this proxy doesn't support X" from "there was no
// data here this time". That exact confusion already cost this project twice
// (`tool_names`, `/health` — see lib/mcp-doctor.mjs's header). This module
// exists so nothing downstream has to guess again.
//
// A 404 IS NOT A FAILURE — IT IS AN ANSWER
// -------------------------------------------
// `/version` was introduced at a specific OxideGate release. A proxy older
// than that will 404 on it, and that 404 is the MOST informative response
// this endpoint can give: "I predate the capabilities contract." Treating it
// as `unknown` would throw away a fact the proxy just told us, and would
// make a perfectly healthy old proxy look like a broken probe. So a 404
// here degrades to `{ status: 'known', reason: 'pre-contract' }` — `known`,
// on purpose, carrying `reason` on purpose. It is the one branch in this
// module where `status: 'known'` and a `reason` field coexist.
//
// THE TRI-STATE HELPERS, AND THE RULE THAT GOVERNS THEM
// ---------------------------------------------------------
// `publishesEndpoint` / `publishesField` answer three, not two, questions:
//   true  — the proxy told us it publishes this.
//   false — the proxy told us it does NOT publish this.
//   null  — we could not ask (unreachable, timeout, malformed answer, or a
//           pre-contract proxy that never got the chance to say anything).
//
// Collapsing `null` into `false` is EXACTLY the bug this module exists to
// prevent — the same "absent measurement is never a zero measurement"
// invariant that governs `lib/mcp-snapshot.mjs`, moved to booleans instead
// of numbers. A caller that cannot tell "not offered" from "could not ask"
// will build features on proxies that never got the chance to say no.

/**
 * Un `AbortSignal.timeout()` real. Node lo trae con este mismo nombre desde
 * hace tiempo, así que no hay dependencia nueva que añadir — es builtin.
 */
function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

function hasValidShape(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof body.contract === 'number' &&
    Array.isArray(body.endpoints) &&
    Array.isArray(body.fields) &&
    typeof body.oxidegate === 'string'
  );
}

/**
 * Sondea `GET {baseUrl}/version`. NUNCA lanza — cualquier fallo de red, de
 * tiempo, de parseo o de forma degrada a `{ status: 'unknown', reason }`,
 * salvo el 404, que es información afirmativa y degrada a
 * `{ status: 'known', reason: 'pre-contract' }` (ver cabecera del módulo).
 */
export async function readProxyVersion({ baseUrl, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/version`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isTimeoutError(err)) return { status: 'unknown', reason: 'timeout' };
    return { status: 'unknown', reason: 'unreachable' };
  }

  if (res.status === 404) {
    // La respuesta AFIRMATIVA «este proxy es anterior al contrato» — no un
    // hueco, no un fallo de sondeo.
    return { status: 'known', reason: 'pre-contract' };
  }

  if (!res.ok) {
    return { status: 'unknown', reason: `http-${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 'unknown', reason: 'unparseable' };
  }

  if (!hasValidShape(body)) {
    // Forma inesperada: NO se inventan campos ausentes ni se rellena con lo
    // que sí vino. La respuesta entera se descarta como no fiable.
    return { status: 'unknown', reason: 'unexpected-shape' };
  }

  return {
    status: 'known',
    contract: body.contract,
    endpoints: body.endpoints,
    fields: body.fields,
    oxidegate: body.oxidegate,
  };
}

/**
 * `true` — el proxy declaró este endpoint.
 * `false` — el proxy declaró su contrato y este endpoint NO está en él.
 * `null` — no se pudo preguntar (inalcanzable, timeout, forma inesperada, o
 *          un proxy pre-contrato que nunca llegó a decir nada).
 *
 * `null` JAMÁS se colapsa en `false` — es el invariante que este módulo
 * existe para proteger.
 */
export function publishesEndpoint(version, endpoint) {
  if (version?.status !== 'known' || !Array.isArray(version.endpoints)) return null;
  return version.endpoints.includes(endpoint);
}

/** Mismo contrato tri-estado que `publishesEndpoint`, para `fields`. */
export function publishesField(version, field) {
  if (version?.status !== 'known' || !Array.isArray(version.fields)) return null;
  return version.fields.includes(field);
}
