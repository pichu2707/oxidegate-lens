// lib/mcp-opencode-cache.mjs
//
// CONTRACT
// --------
// Reads the copy of this plugin that OpenCode keeps for itself, and says
// whether it is the same one you are running. PURE except for one optional
// disk read with an injectable path — the same shape `lib/mcp-snapshot.mjs`
// and `lib/mcp-endpoint.mjs` already use. It NEVER deletes anything.
//
// Exports:
//   resolveOpenCodeCachePath({ home?, pkg? }) -> string
//   readCachedPluginVersion({ path? })        -> CachedResult
//   diagnoseCache({ cached, running })        -> Diagnosis
//
// CachedResult is one of:
//   { status: 'known', version }
//   { status: 'absent' }      // no cache at all — NOT the same as a stale one
//   { status: 'unreadable' }  // present but could not be parsed
//
// Diagnosis: { status: 'match'|'mismatch'|'absent'|'unknown', cached?, running? }
//
// WHY THIS EXISTS
// ----------------
// 0.6.1 shipped the fix that `opencode plugin oxidegate-lens` needed, and the
// install kept failing in exactly the same way as 0.6.0. The cause:
//
//   ~/.cache/opencode/packages/oxidegate-lens@latest/package.json
//     -> { "dependencies": { "oxidegate-lens": "0.6.0" } }
//
// The directory is named `@latest` but the version inside is PINNED and does
// not re-resolve. OpenCode was reading an old copy while npm already served
// the new one, and its error message described — accurately — a package that
// was no longer the published one.
//
// That is the worst shape a bug can take: a correct message about the wrong
// object. It sent the investigation straight at the manifest, which was fine,
// and nearly bought a whole build step to solve a problem that did not exist.
//
// IT NAMES, IT DOES NOT FIX
// ---------------------------
// Deleting a directory is destructive and has to be asked for, never done as
// a side effect of looking. `bin/oxidegate-savings.mjs --clear-opencode-cache`
// is the explicit door.
//
// AN ABSENT CACHE IS NOT A STALE CACHE
// --------------------------------------
// Same invariant as everywhere else in this repo — an absent measurement is
// never a zero — applied to a directory. Anyone who installs through Homebrew
// and wires the plugin by path has no OpenCode cache at all, and telling them
// to clear a stale one would send them to delete something that is not there.
// And an unreadable cache is `unknown`, NEVER `match`: declaring "all good"
// about something that could not be read closes the investigation that would
// have found the problem.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PACKAGE_NAME = 'oxidegate-lens';

/**
 * La ruta REAL que crea OpenCode, verificada contra una instalación de
 * verdad. El sufijo `@latest` forma parte del nombre del directorio y no
 * significa que dentro haya la última versión — ese es justamente el engaño.
 */
export function resolveOpenCodeCachePath({ home, pkg = PACKAGE_NAME } = {}) {
  return join(home ?? homedir(), '.cache', 'opencode', 'packages', `${pkg}@latest`);
}

export function readCachedPluginVersion({ path, pkg = PACKAGE_NAME } = {}) {
  let crudo;
  try {
    crudo = readFileSync(join(path ?? resolveOpenCodeCachePath(), 'package.json'), 'utf8');
  } catch {
    // No hay copia. Es un hecho, no una avería: quien instala por Homebrew y
    // cablea por ruta nunca tendrá una.
    return { status: 'absent' };
  }

  try {
    const version = JSON.parse(crudo)?.dependencies?.[pkg];
    if (typeof version !== 'string' || version === '') return { status: 'unreadable' };
    return { status: 'known', version };
  } catch {
    return { status: 'unreadable' };
  }
}

export function diagnoseCache({ cached, running } = {}) {
  if (typeof running !== 'string' || running === '') return { status: 'unknown' };
  if (!cached || cached.status === 'unreadable') return { status: 'unknown' };
  if (cached.status === 'absent') return { status: 'absent' };

  // Se compara por IGUALDAD, no por "más vieja". Averiguar cuál es anterior
  // exigiría comparar semver, y una caché MÁS NUEVA que el binario que
  // ejecutas es igual de digna de mención: en los dos casos OpenCode está
  // cargando algo distinto de lo que crees. Nombrar las dos versiones deja
  // que el usuario decida; ordenarlas por su cuenta añadiría una conclusión
  // que este módulo no necesita.
  return cached.version === running
    ? { status: 'match', cached: cached.version, running }
    : { status: 'mismatch', cached: cached.version, running };
}
