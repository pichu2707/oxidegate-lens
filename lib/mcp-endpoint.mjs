// lib/mcp-endpoint.mjs
//
// CONTRACT
// --------
// Finds OxideGate without the user having to say where it is. PURE except
// for one optional disk read, which takes an injectable path — the same
// shape `lib/mcp-snapshot.mjs` already uses. It performs NO network I/O:
// `chooseEndpoint` receives an injected `verify`, so the binary owns fetch
// and this module owns the decision.
//
// Exports:
//   parseListeningUrl(text) -> string | null
//   resolveProxyLogPath() -> string
//   readProxyLogUrl({ path? }) -> string | null
//   buildEndpointCandidates({ env?, loggedUrl?, ports? }) -> Candidate[]
//   chooseEndpoint({ candidates, verify }) -> Promise<Result>
//
// Candidate: { baseUrl, source }
//   source: 'env-url' | 'env-port' | 'proxy-log' | 'known-port'
//
// Result is one of:
//   { status: 'found', baseUrl, source, overrode: Candidate|null, tried: [...] }
//   { status: 'not-found', tried: [...] }
//
// Each `tried` entry: { baseUrl, source, reachable, isOxidegate }
//
// WHY THIS EXISTS
// ----------------
// The default port (8080) was occupied by a WordPress. The lens asked it,
// got a 302, and — having no way to tell "this is not OxideGate" from
// "OxideGate has seen no traffic" — printed *"the proxy has not seen any
// request yet"*. A false negative indistinguishable from the legitimate
// case, for months. `--doctor` could already catch it, but only if you knew
// to ask, and only after you already suspected something.
//
// A default value that the tool's own help tells you to change is not a
// default: it is a required field wearing a disguise. The fix is not a
// better number — every number is somebody's occupied port. The fix is to
// stop asking the user for it.
//
// THE RULE THAT GOVERNS EVERY BRANCH
// ------------------------------------
// **Answering on a port does not make you OxideGate.** A candidate is
// accepted on IDENTITY, never on reachability. That is what kills the whole
// squatter class: it no longer matters who lives on 8080, because nothing
// gets picked without proving what it is. It is the same invariant the rest
// of the repo already holds — an absent measurement is never a zero — moved
// one step earlier, to the question of who we are even talking to.
//
// A URL IS A PIN, A PORT IS A HINT
// ----------------------------------
// `OXIDEGATE_LENS_URL` names host AND port, so it is taken literally and
// nothing else is probed. `OXIDEGATE_PORT` fixes one field, so a stale one
// falls through to discovery — announced, never silently. The line is not
// convenience: it is the difference between completing what is missing and
// overwriting what is already there.
//
// DISCOVERY IS NOT SILENT DISOBEDIENCE
// --------------------------------------
// If the user set `OXIDEGATE_PORT` and the proxy is not there, the search
// continues — but the result carries `overrode`, so the binary can say what
// it ignored and why. Fixing someone's mistake without telling them is the
// same as not fixing it: next time they make it again, and now with a tool
// that works, which is worse. Note the asymmetry in `overrode`: only an
// EXPLICIT instruction is worth announcing. Reporting that we skipped a port
// the user never mentioned sends them hunting for a mistake they did not
// make.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// El puerto que la lente ha usado siempre. Se mantiene por compatibilidad:
// quien lo tenga funcionando hoy no debe notar este cambio.
const DEFAULT_PORT = 8080;

// El puerto que enseña el README en «Empieza aquí». No es un número mágico:
// es el que va a tener quien siguió las instrucciones publicadas.
const DOCUMENTED_PORT = 8899;

/**
 * La línea que escribe OxideGate al arrancar, en su propio log:
 *
 *   🛰️  Escuchando en http://127.0.0.1:8899
 *
 * Es la ÚNICA fuente que no es una suposición: la dice el propio proxy. El
 * resto del log también lleva URLs (`/health`, `/requests`), así que buscar
 * "la primera URL" o "la última" acierta por casualidad y falla en cuanto
 * OxideGate añada una ruta más. Se ancla a la palabra.
 *
 * `[^\s]+` y no `\S+` a propósito: el log lleva emojis y espacios dobles, y
 * la URL termina donde termina el espacio en blanco, sea cual sea.
 */
const LISTENING_RE = /Escuchando en\s+(https?:\/\/[^\s]+)/g;

export function parseListeningUrl(text) {
  if (typeof text !== 'string' || text === '') return null;

  // El log se ACUMULA entre reinicios. Si el proxy se levantó ayer en un
  // puerto y hoy en otro, la verdad es la de hoy — se coge la última.
  let ultima = null;
  for (const m of text.matchAll(LISTENING_RE)) ultima = m[1];
  return ultima;
}

export function resolveProxyLogPath() {
  // El mismo directorio del que la lente ya lee telemetría. No se inventa
  // una ruta nueva ni se acuerda un contrato nuevo con OxideGate.
  return join(homedir(), '.config', 'oxidegate', 'proxy.log');
}

/**
 * Lee el log y saca la URL. TOLERANTE: si no hay fichero, no se puede leer o
 * no dice nada, devuelve null y la búsqueda sigue por otros candidatos. Un
 * descubrimiento que no se pudo hacer no es un error del usuario.
 */
export function readProxyLogUrl({ path } = {}) {
  try {
    return parseListeningUrl(readFileSync(path ?? resolveProxyLogPath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Un puerto es un entero de 1 a 65535 y nada más.
 *
 * `Number('')` es 0 y `Number('  ')` también: sin este guardia, un
 * `OXIDEGATE_PORT=""` —que es lo que deja un `export` vacío en el perfil—
 * fabricaría `http://127.0.0.1:0`, y el fallo aparecería tres capas más
 * abajo como un error de red incomprensible.
 */
function parsePort(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

const urlForPort = (port) => `http://127.0.0.1:${port}`;

export function buildEndpointCandidates({ env = {}, loggedUrl = null, ports } = {}) {
  // Una URL completa es un PIN, no una pista: nombra host y puerto, así que
  // ponerse a adivinar otros sitios después es ignorar una instrucción
  // precisa. Un puerto solo fija UN campo, y ahí sí cabe corregir —
  // anunciándolo. La distinción no es de conveniencia: es la diferencia
  // entre completar lo que falta y sobrescribir lo que sobra.
  const pin = typeof env.OXIDEGATE_LENS_URL === 'string' ? env.OXIDEGATE_LENS_URL.trim() : '';
  if (pin !== '') return [{ baseUrl: pin, source: 'env-url' }];

  const conocidos = ports ?? [DEFAULT_PORT, DOCUMENTED_PORT];

  // El orden ES el contrato, de más explícito a más adivinado:
  //   lo que el usuario dijo  >  lo que el proxy declaró  >  lo que solemos ver
  const enOrden = [
    { baseUrl: urlOrNull(parsePort(env.OXIDEGATE_PORT)), source: 'env-port' },
    { baseUrl: loggedUrl, source: 'proxy-log' },
    ...conocidos.map((p) => ({ baseUrl: urlForPort(p), source: 'known-port' })),
  ];

  // Deduplica conservando la PRIMERA aparición: si el mismo sitio llega por
  // dos caminos, gana la fuente más explícita, que es la que luego se le
  // enseña al usuario. Y sondear dos veces la misma URL es una petición
  // regalada en un camino que se recorre en cada ejecución.
  const vistas = new Set();
  return enOrden.filter((c) => {
    if (!c.baseUrl || vistas.has(c.baseUrl)) return false;
    vistas.add(c.baseUrl);
    return true;
  });
}

function urlOrNull(port) {
  return port === null ? null : urlForPort(port);
}

const EXPLICITAS = new Set(['env-url', 'env-port']);

/**
 * Recorre los candidatos y se queda con el primero que DEMUESTRA ser
 * OxideGate. `verify(baseUrl) -> { reachable, isOxidegate }` va inyectada:
 * este módulo no hace fetch, igual que el reloj va inyectado en el snapshot.
 *
 * Secuencial y no en paralelo, a propósito. En paralelo se ganarían unos
 * milisegundos a cambio de lanzar peticiones a puertos ajenos de la máquina
 * del usuario que casi nunca hacen falta: en el camino feliz el primer
 * candidato acierta y no se toca ningún otro puerto.
 */
export async function chooseEndpoint({ candidates = [], verify }) {
  const tried = [];
  let overrode = null;

  for (const candidate of candidates) {
    // Un `verify` que revienta es un candidato descartado, no el final de la
    // búsqueda. Es literalmente el caso para el que existe este módulo: el
    // puerto donde no hay nada escuchando da ECONNREFUSED.
    let observacion;
    try {
      observacion = await verify(candidate.baseUrl);
    } catch {
      observacion = { reachable: false, isOxidegate: false };
    }

    const reachable = observacion?.reachable === true;
    const isOxidegate = observacion?.isOxidegate === true;
    tried.push({ baseUrl: candidate.baseUrl, source: candidate.source, reachable, isOxidegate });

    if (isOxidegate) {
      return { status: 'found', baseUrl: candidate.baseUrl, source: candidate.source, overrode, tried };
    }

    // Se recuerda la PRIMERA orden explícita que no era OxideGate. Solo
    // sirve si más adelante se encuentra el proxy en otro sitio: entonces
    // hay algo que contarle al usuario. Si no se encuentra nada, el mensaje
    // que toca es otro y `tried` lo lleva entero.
    if (overrode === null && EXPLICITAS.has(candidate.source)) overrode = candidate;
  }

  return { status: 'not-found', tried };
}
